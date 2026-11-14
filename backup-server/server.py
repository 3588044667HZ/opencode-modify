#!/usr/bin/env python3
"""OpenCode chunked backup server.

Standard library only. See README.md for protocol, deployment and restore notes.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import datetime as dt
import getpass
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import shutil
import sqlite3
import struct
import sys
import tempfile
import threading
import time
import traceback
import zlib
from collections import deque
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlsplit

VERSION = "1"

USER_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}\Z")
SHA_RE = re.compile(r"^[0-9a-fA-F]{64}\Z")
SNAPSHOT_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}\Z")
PACK_FILE_RE = re.compile(r"^[A-Za-z0-9._-]+\.pack\Z")
PACK_NUM_RE = re.compile(r"^(\d{8})\.pack\Z")

MAX_CHUNK_SIZE = 16 * 1024 * 1024
MAX_STORED_SIZE = MAX_CHUNK_SIZE + 1024 * 1024
MAX_MANIFEST_SIZE = 64 * 1024 * 1024
MAX_FORM_SIZE = 1024 * 1024
MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024
PACK_MAX_SIZE = 512 * 1024 * 1024
FSYNC_BATCH_BYTES = 8 * 1024 * 1024
PENDING_FLUSH_AGE = 10.0
FLUSHER_INTERVAL = 2.0
GC_GARBAGE_RATIO = 0.30

PACK_MAGIC = b"OBK1"
PACK_HEADER = struct.Struct(">4s32sIII")

SCRYPT_N = 2**14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 32
MIN_ADMIN_PASSWORD = 8

ADMIN_SESSION_COOKIE = "obk_admin"
ADMIN_SESSION_TTL = 12 * 3600
ADMIN_PENDING_TTL = 15 * 60
ADMIN_LOGIN_WINDOW = 300.0
ADMIN_LOGIN_MAX_FAILURES = 5

ADMIN_CSP = (
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; "
    "base-uri 'none'; frame-ancestors 'none'"
)

WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


class ApiError(Exception):
    def __init__(self, status, code, message, headers=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.headers = headers or {}


# ---------------------------------------------------------------------------
# Generic helpers
# ---------------------------------------------------------------------------


def now_iso():
    return (
        dt.datetime.now(dt.timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def fsync_dir(path):
    if os.name == "nt":
        return
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def chmod_quiet(path, mode):
    try:
        os.chmod(path, mode)
    except OSError:
        pass


def atomic_write_bytes(path, data, mode=0o600):
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".obk-tmp-", dir=directory)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        chmod_quiet(tmp_path, mode)
        for attempt in range(20):
            try:
                os.replace(tmp_path, path)
                break
            except PermissionError:
                if os.name != "nt" or attempt == 19:
                    raise
                time.sleep(0.05)
        fsync_dir(directory)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def atomic_write_json(path, value, mode=0o600):
    payload = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
    atomic_write_bytes(path, (payload + "\n").encode("utf-8"), mode=mode)


def parse_iso8601(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 64:
        raise ApiError(400, "invalid_manifest", "created_at must be an ISO8601 string")
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        raise ApiError(400, "invalid_manifest", "created_at must be an ISO8601 string")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def validate_username(value):
    if (
        not isinstance(value, str)
        or not USER_RE.match(value)
        or value in (".", "..")
    ):
        raise ApiError(
            400,
            "invalid_username",
            "username must match ^[A-Za-z0-9._-]{1,64}$",
        )
    if os.name == "nt":
        if value.endswith("."):
            raise ApiError(400, "invalid_username", "username must not end with a dot")
        if value.split(".")[0].upper() in WINDOWS_RESERVED_NAMES:
            raise ApiError(400, "invalid_username", "username is reserved on Windows")
    return value


def validate_snapshot_id(value):
    if (
        not isinstance(value, str)
        or not SNAPSHOT_ID_RE.match(value)
        or value in (".", "..")
    ):
        raise ApiError(
            400,
            "invalid_snapshot_id",
            "snapshot id must match ^[A-Za-z0-9._-]{1,128}$",
        )
    if os.name == "nt":
        if value.endswith("."):
            raise ApiError(400, "invalid_snapshot_id", "snapshot id must not end with a dot")
        if value.split(".")[0].upper() in WINDOWS_RESERVED_NAMES:
            raise ApiError(400, "invalid_snapshot_id", "snapshot id is reserved on Windows")
    return value


def normalize_sha(value, field="sha256"):
    if not isinstance(value, str) or not SHA_RE.match(value):
        raise ApiError(400, "invalid_sha256", f"{field} must be 64 hexadecimal characters")
    return value.lower()


def validate_secret(value, kind):
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise ApiError(400, f"invalid_{kind}", f"{kind} must be between 1 and 1024 characters")
    return value


def validate_token(value):
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 512
        or any(ord(char) < 33 or ord(char) > 126 for char in value)
    ):
        raise ApiError(
            400,
            "invalid_token",
            "token must be 1-512 printable ASCII characters without whitespace",
        )
    return value


def validate_manifest_path(value):
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise ApiError(400, "invalid_manifest", "file path must be a non-empty string")
    if any(ord(char) < 32 for char in value):
        raise ApiError(400, "invalid_manifest", "file path contains control characters")

    candidates = [value]
    try:
        candidates.append(unquote(value, encoding="utf-8", errors="strict"))
    except UnicodeDecodeError:
        raise ApiError(400, "invalid_manifest", "file path contains invalid percent-encoding")

    for candidate in candidates:
        if any(ord(char) < 32 for char in candidate):
            raise ApiError(400, "invalid_manifest", "file path contains control characters")
        if candidate.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", candidate):
            raise ApiError(400, "invalid_manifest", "file path must be relative")
        if any(part == ".." for part in re.split(r"[\\/]+", candidate)):
            raise ApiError(400, "invalid_manifest", "file path must not contain ..")
    return value


def normalize_manifest(obj):
    if not isinstance(obj, dict):
        raise ApiError(400, "invalid_manifest", "manifest must be a JSON object")
    version = obj.get("version")
    if version != 1 or isinstance(version, bool):
        raise ApiError(400, "invalid_manifest", "manifest version must be 1")

    snapshot_id = validate_snapshot_id(obj.get("id"))
    created_at = obj.get("created_at")
    parse_iso8601(created_at)

    source = obj.get("source")
    if not isinstance(source, dict):
        raise ApiError(400, "invalid_manifest", "source must be an object")
    hostname = source.get("hostname", "")
    opencode_version = source.get("opencode_version", "")
    if not isinstance(hostname, str) or len(hostname) > 256:
        raise ApiError(400, "invalid_manifest", "source.hostname must be a string")
    if not isinstance(opencode_version, str) or len(opencode_version) > 256:
        raise ApiError(400, "invalid_manifest", "source.opencode_version must be a string")

    raw_files = obj.get("files")
    if not isinstance(raw_files, list) or len(raw_files) > 100000:
        raise ApiError(400, "invalid_manifest", "files must be a list")

    files = []
    seen_paths = set()
    total_from_files = 0
    for item in raw_files:
        if not isinstance(item, dict):
            raise ApiError(400, "invalid_manifest", "each file must be an object")
        path = validate_manifest_path(item.get("path"))
        if path in seen_paths:
            raise ApiError(400, "invalid_manifest", f"duplicate file path {path}")
        seen_paths.add(path)

        size = item.get("size")
        if not isinstance(size, int) or isinstance(size, bool) or size < 0 or size > 2**63 - 1:
            raise ApiError(400, "invalid_manifest", "file size must be a non-negative integer")
        file_sha = normalize_sha(item.get("sha256"), "file sha256")

        raw_chunks = item.get("chunks")
        if not isinstance(raw_chunks, list) or len(raw_chunks) > 1000000:
            raise ApiError(400, "invalid_manifest", "chunks must be a list")
        chunks = [normalize_sha(chunk, "chunk sha256") for chunk in raw_chunks]

        files.append(
            {
                "path": path,
                "size": size,
                "sha256": file_sha,
                "chunks": chunks,
            }
        )
        total_from_files += size

    total_bytes = obj.get("total_bytes")
    if (
        not isinstance(total_bytes, int)
        or isinstance(total_bytes, bool)
        or total_bytes < 0
        or total_bytes > 2**63 - 1
    ):
        raise ApiError(400, "invalid_manifest", "total_bytes must be a non-negative integer")
    if total_bytes != total_from_files:
        raise ApiError(400, "invalid_manifest", "total_bytes does not match file sizes")

    return {
        "version": 1,
        "id": snapshot_id,
        "created_at": created_at.strip(),
        "source": {
            "hostname": hostname,
            "opencode_version": opencode_version,
        },
        "files": files,
        "total_bytes": total_bytes,
    }


def parse_request_path(raw_path):
    split = urlsplit(raw_path)
    path = split.path
    if not path.startswith("/"):
        raise ApiError(400, "invalid_path", "request path must start with /")
    raw_parts = path.split("/")
    parts = []
    for index, raw_part in enumerate(raw_parts[1:], start=1):
        if raw_part == "":
            if index == len(raw_parts) - 1:
                continue
            raise ApiError(400, "invalid_path", "empty path segment")
        try:
            decoded = unquote(raw_part, encoding="utf-8", errors="strict")
        except UnicodeDecodeError:
            raise ApiError(400, "invalid_path", "invalid percent-encoding")
        if decoded in ("", ".", ".."):
            raise ApiError(400, "invalid_path", "invalid path segment")
        if any(char in decoded for char in ("/", "\\", "\x00")):
            raise ApiError(400, "invalid_path", "invalid path segment")
        if any(ord(char) < 32 for char in decoded):
            raise ApiError(400, "invalid_path", "invalid path segment")
        parts.append(decoded)
    return parts


def parse_authorization(value):
    if not value:
        return None
    pieces = value.split(None, 1)
    if len(pieces) != 2:
        return None
    scheme = pieces[0].lower()
    rest = pieces[1].strip()
    if scheme == "bearer":
        if not rest:
            return None
        return "bearer", rest
    if scheme != "basic":
        return None
    try:
        decoded = base64.b64decode(rest, validate=True)
    except (binascii.Error, ValueError):
        try:
            decoded = base64.b64decode(rest + "=" * (-len(rest) % 4))
        except (binascii.Error, ValueError):
            return None
    if len(decoded) > 4096 or b":" not in decoded:
        return None
    username_bytes, _, password_bytes = decoded.partition(b":")
    try:
        username = username_bytes.decode("utf-8")
        password = password_bytes.decode("utf-8")
    except UnicodeDecodeError:
        return None
    return "basic", (username, password)


# ---------------------------------------------------------------------------
# Password hashing
# ---------------------------------------------------------------------------


def make_secret_hash(secret):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        secret.encode("utf-8"),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=SCRYPT_DKLEN,
    )
    return {
        "salt": salt.hex(),
        "hash": digest.hex(),
        "n": SCRYPT_N,
        "r": SCRYPT_R,
        "p": SCRYPT_P,
        "dklen": SCRYPT_DKLEN,
    }


def check_secret_hash(secret, spec):
    if not isinstance(secret, str) or not secret or len(secret) > 1024:
        return False
    if not isinstance(spec, dict):
        return False
    try:
        salt = bytes.fromhex(spec["salt"])
        expected = bytes.fromhex(spec["hash"])
        n = int(spec["n"])
        r = int(spec["r"])
        p = int(spec["p"])
        dklen = int(spec.get("dklen", len(expected)))
    except (KeyError, TypeError, ValueError):
        return False
    if not (
        2**10 <= n <= 2**20
        and 1 <= r <= 32
        and 1 <= p <= 16
        and 16 <= dklen <= 64
        and len(expected) == dklen
        and len(salt) >= 8
    ):
        return False
    try:
        actual = hashlib.scrypt(
            secret.encode("utf-8"),
            salt=salt,
            n=n,
            r=r,
            p=p,
            dklen=dklen,
        )
    except (ValueError, MemoryError, OverflowError):
        return False
    return hmac.compare_digest(actual, expected)


# ---------------------------------------------------------------------------
# Pack records
# ---------------------------------------------------------------------------


def decompress_chunk(payload, expected_len):
    inflater = zlib.decompressobj()
    try:
        raw = inflater.decompress(payload, expected_len + 1)
    except zlib.error:
        raise
    if (
        len(raw) > expected_len
        or not inflater.eof
        or inflater.unconsumed_tail
        or inflater.unused_data
    ):
        raise zlib.error("invalid zlib stream")
    return raw


def scan_pack(path, start=0, allow_crc_errors=False):
    """Scan a pack from start.

    Returns good records plus repair information. CRC covers the stored
    (compressed) payload, so on-disk bit rot is detected before decompression.
    """
    try:
        file_size = os.path.getsize(path)
    except OSError as exc:
        return {
            "records": [],
            "scanned_end": start,
            "last_good_end": start,
            "truncated": True,
            "framing_error": f"cannot stat pack: {exc}",
            "crc_errors": 0,
            "file_size": 0,
        }

    records = []
    offset = start
    scanned_end = start
    last_good_end = start
    truncated = False
    framing_error = None
    crc_errors = 0

    try:
        with open(path, "rb") as handle:
            while offset < file_size:
                if file_size - offset < PACK_HEADER.size:
                    truncated = True
                    break
                handle.seek(offset)
                header = handle.read(PACK_HEADER.size)
                if len(header) != PACK_HEADER.size:
                    truncated = True
                    break
                magic, sha_raw, raw_len, stored_len, expected_crc = PACK_HEADER.unpack(header)
                if magic != PACK_MAGIC:
                    framing_error = f"bad magic at offset {offset}"
                    break
                if (
                    raw_len > MAX_CHUNK_SIZE
                    or stored_len < 1
                    or stored_len > MAX_STORED_SIZE
                ):
                    framing_error = f"invalid record length at offset {offset}"
                    break
                end = offset + PACK_HEADER.size + stored_len
                if end > file_size:
                    truncated = True
                    break
                payload = handle.read(stored_len)
                if len(payload) != stored_len:
                    truncated = True
                    break
                scanned_end = end
                actual_crc = zlib.crc32(payload) & 0xFFFFFFFF
                if actual_crc != expected_crc:
                    crc_errors += 1
                    if allow_crc_errors:
                        offset = end
                        continue
                    break
                records.append(
                    {
                        "sha256": sha_raw.hex(),
                        "offset": offset + PACK_HEADER.size,
                        "record_offset": offset,
                        "raw_len": raw_len,
                        "stored_len": stored_len,
                        "crc32": expected_crc,
                        "end_offset": end,
                    }
                )
                last_good_end = end
                offset = end
    except OSError as exc:
        return {
            "records": records,
            "scanned_end": scanned_end,
            "last_good_end": last_good_end,
            "truncated": True,
            "framing_error": f"cannot read pack: {exc}",
            "crc_errors": crc_errors,
            "file_size": file_size,
        }

    return {
        "records": records,
        "scanned_end": scanned_end,
        "last_good_end": last_good_end,
        "truncated": truncated,
        "framing_error": framing_error,
        "crc_errors": crc_errors,
        "file_size": file_size,
    }


def truncate_file(path, size):
    with open(path, "r+b") as handle:
        handle.truncate(size)
        handle.flush()
        os.fsync(handle.fileno())


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------


class UserStore:
    def __init__(self, data_dir, verbose=False):
        self.path = os.path.join(data_dir, "users.json")
        self.verbose = verbose
        self._lock = threading.RLock()
        self._users = {}
        self._stamp = None
        self._auth_cache = set()
        self._reload_locked(force=True)
        chmod_quiet(self.path, 0o600)

    def _log(self, message):
        if self.verbose:
            sys.stderr.write(f"[{now_iso()}] {message}\n")
            sys.stderr.flush()

    def _reload_locked(self, force=False):
        try:
            stat = os.stat(self.path)
        except FileNotFoundError:
            raise ApiError(
                500,
                "not_initialized",
                "users.json not found; run: init --data-dir PATH",
            )
        stamp = (stat.st_mtime_ns, stat.st_size)
        if not force and stamp == self._stamp:
            return
        if stat.st_size > 16 * 1024 * 1024:
            raise ApiError(500, "users_config_invalid", "users.json is too large")
        try:
            with open(self.path, "rb") as handle:
                raw = handle.read()
            data = json.loads(raw.decode("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(
                500,
                "users_config_invalid",
                f"cannot read users.json ({type(exc).__name__})",
            )
        if (
            not isinstance(data, dict)
            or data.get("version") != 1
            or not isinstance(data.get("users"), dict)
        ):
            raise ApiError(500, "users_config_invalid", "users.json structure is invalid")

        seen = set()
        for name, record in data["users"].items():
            if (
                not isinstance(name, str)
                or not USER_RE.match(name)
                or name in (".", "..")
                or not isinstance(record, dict)
            ):
                raise ApiError(500, "users_config_invalid", "users.json contains an invalid user")
            folded = name.casefold()
            if folded in seen:
                raise ApiError(
                    500,
                    "users_config_invalid",
                    "users.json contains case-insensitive duplicate usernames",
                )
            seen.add(folded)

        self._users = data["users"]
        self._stamp = stamp
        self._auth_cache.clear()

    def _save_locked(self, users):
        atomic_write_json(self.path, {"version": 1, "users": users}, mode=0o600)
        stat = os.stat(self.path)
        self._users = users
        self._stamp = (stat.st_mtime_ns, stat.st_size)
        self._auth_cache.clear()

    def list_users(self):
        with self._lock:
            self._reload_locked()
            result = []
            for name in sorted(self._users):
                record = self._users[name]
                result.append(
                    {
                        "user": name,
                        "created_at": record.get("created_at", ""),
                        "disabled": bool(record.get("disabled", False)),
                        "has_password": isinstance(record.get("password_hash"), dict),
                        "has_token": isinstance(record.get("token_hash"), dict),
                    }
                )
            return result

    def list_names(self):
        return [item["user"] for item in self.list_users()]

    def add_user(self, user, password=None, token=None, generate_token=False):
        user = validate_username(user)
        if password is not None:
            validate_secret(password, "password")
        if token is not None:
            validate_token(token)
        if password is None and token is None:
            generate_token = True

        generated = None
        if generate_token:
            token = secrets.token_urlsafe(32)
            generated = token

        password_hash = make_secret_hash(password) if password is not None else None
        token_hash = make_secret_hash(token) if token is not None else None
        if password_hash is None and token_hash is None:
            raise ApiError(400, "no_credentials", "a password or token is required")

        with self._lock:
            self._reload_locked()
            if any(existing.casefold() == user.casefold() for existing in self._users):
                raise ApiError(409, "user_exists", f"user {user} already exists")
            users = dict(self._users)
            users[user] = {
                "password_hash": password_hash,
                "token_hash": token_hash,
                "disabled": False,
                "created_at": now_iso(),
            }
            self._save_locked(users)
        return generated

    def set_password(self, user, password):
        validate_secret(password, "password")
        password_hash = make_secret_hash(password)
        with self._lock:
            self._reload_locked()
            record = self._users.get(user)
            if not isinstance(record, dict):
                raise ApiError(404, "user_not_found", f"user {user} does not exist")
            users = dict(self._users)
            updated = dict(record)
            updated["password_hash"] = password_hash
            users[user] = updated
            self._save_locked(users)

    def issue_token(self, user):
        token = secrets.token_urlsafe(32)
        token_hash = make_secret_hash(token)
        with self._lock:
            self._reload_locked()
            record = self._users.get(user)
            if not isinstance(record, dict):
                raise ApiError(404, "user_not_found", f"user {user} does not exist")
            users = dict(self._users)
            updated = dict(record)
            updated["token_hash"] = token_hash
            users[user] = updated
            self._save_locked(users)
        return token

    def set_disabled(self, user, disabled):
        with self._lock:
            self._reload_locked()
            record = self._users.get(user)
            if not isinstance(record, dict):
                raise ApiError(404, "user_not_found", f"user {user} does not exist")
            users = dict(self._users)
            updated = dict(record)
            updated["disabled"] = bool(disabled)
            users[user] = updated
            self._save_locked(users)

    def delete_user(self, user):
        with self._lock:
            self._reload_locked()
            if user not in self._users:
                raise ApiError(404, "user_not_found", f"user {user} does not exist")
            users = dict(self._users)
            users.pop(user, None)
            self._save_locked(users)

    def _cached(self, key):
        with self._lock:
            return key in self._auth_cache

    def _remember(self, key, stamp):
        with self._lock:
            if stamp != self._stamp:
                return
            if len(self._auth_cache) > 4096:
                self._auth_cache.clear()
            self._auth_cache.add(key)

    def verify_token(self, user, token):
        if not isinstance(token, str) or not token or len(token) > 512:
            return False
        with self._lock:
            self._reload_locked()
            stamp = self._stamp
            record = self._users.get(user)
            if not isinstance(record, dict) or record.get("disabled"):
                return False
            spec = record.get("token_hash")
            if not isinstance(spec, dict):
                return False
        key = (user, "token", hashlib.sha256(token.encode("utf-8")).digest())
        if self._cached(key):
            return True
        if not check_secret_hash(token, spec):
            return False
        self._remember(key, stamp)
        return True

    def verify_password(self, user, password):
        if not isinstance(password, str) or not password or len(password) > 1024:
            return False
        with self._lock:
            self._reload_locked()
            stamp = self._stamp
            record = self._users.get(user)
            if not isinstance(record, dict) or record.get("disabled"):
                return False
            spec = record.get("password_hash")
            if not isinstance(spec, dict):
                return False
        key = (user, "password", hashlib.sha256(password.encode("utf-8")).digest())
        if self._cached(key):
            return True
        if not check_secret_hash(password, spec):
            return False
        self._remember(key, stamp)
        return True

    def user_exists(self, user):
        with self._lock:
            self._reload_locked()
            return user in self._users


# ---------------------------------------------------------------------------
# Admin authentication and sessions
# ---------------------------------------------------------------------------


class AdminAuth:
    def __init__(self, data_dir, verbose=False):
        self.path = os.path.join(data_dir, "admin.json")
        self.verbose = verbose
        self._lock = threading.RLock()
        self._sessions = {}
        self._failures = {}
        self._stamp = None
        self._password_hash = None
        self._reload_locked(force=True)
        chmod_quiet(self.path, 0o600)

    def _reload_locked(self, force=False):
        try:
            stat = os.stat(self.path)
        except FileNotFoundError:
            raise ApiError(
                500,
                "admin_not_configured",
                "admin.json not found; run: init --data-dir PATH",
            )
        stamp = (stat.st_mtime_ns, stat.st_size)
        if not force and stamp == self._stamp:
            return
        try:
            with open(self.path, "rb") as handle:
                raw = handle.read()
            data = json.loads(raw.decode("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(
                500,
                "admin_config_invalid",
                f"cannot read admin.json ({type(exc).__name__})",
            )
        if (
            not isinstance(data, dict)
            or data.get("version") != 1
            or not isinstance(data.get("password_hash"), dict)
        ):
            raise ApiError(500, "admin_config_invalid", "admin.json structure is invalid")
        self._password_hash = data["password_hash"]
        self._stamp = stamp

    def _cleanup_locked(self, now):
        expired = []
        for sid, session in self._sessions.items():
            ttl = ADMIN_SESSION_TTL if session.get("authenticated") else ADMIN_PENDING_TTL
            if now - session.get("created", 0.0) > ttl:
                expired.append(sid)
        for sid in expired:
            self._sessions.pop(sid, None)

    def verify_password(self, password):
        if not isinstance(password, str) or not password or len(password) > 1024:
            return False
        with self._lock:
            self._reload_locked()
            spec = dict(self._password_hash)
        return check_secret_hash(password, spec)

    def create_pending_session(self):
        sid = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(32)
        now = time.monotonic()
        with self._lock:
            self._cleanup_locked(now)
            if len(self._sessions) >= 4096:
                oldest = min(
                    self._sessions,
                    key=lambda key: self._sessions[key].get("created", 0.0),
                )
                self._sessions.pop(oldest, None)
            self._sessions[sid] = {
                "csrf": csrf,
                "authenticated": False,
                "created": now,
                "flash": None,
            }
        return sid, csrf

    def get_session(self, sid):
        if not isinstance(sid, str) or not sid or len(sid) > 128:
            return None
        now = time.monotonic()
        with self._lock:
            self._cleanup_locked(now)
            session = self._sessions.get(sid)
            if session is None:
                return None
            return dict(session)

    def rotate_authenticated(self, old_sid):
        sid = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(32)
        now = time.monotonic()
        with self._lock:
            self._cleanup_locked(now)
            self._sessions.pop(old_sid, None)
            self._sessions[sid] = {
                "csrf": csrf,
                "authenticated": True,
                "created": now,
                "flash": None,
            }
        return sid, csrf

    def destroy(self, sid):
        with self._lock:
            self._sessions.pop(sid, None)

    def set_flash(self, sid, flash):
        with self._lock:
            session = self._sessions.get(sid)
            if session is not None:
                session["flash"] = flash

    def pop_flash(self, sid):
        with self._lock:
            session = self._sessions.get(sid)
            if session is None:
                return None
            flash = session.get("flash")
            session["flash"] = None
            return flash

    def rate_limited(self, key):
        now = time.monotonic()
        with self._lock:
            queue = self._failures.get(key)
            if not queue:
                return 0
            while queue and now - queue[0] > ADMIN_LOGIN_WINDOW:
                queue.popleft()
            if not queue:
                self._failures.pop(key, None)
                return 0
            if len(queue) < ADMIN_LOGIN_MAX_FAILURES:
                return 0
            return max(1, int(ADMIN_LOGIN_WINDOW - (now - queue[0])) + 1)

    def record_failure(self, key):
        now = time.monotonic()
        with self._lock:
            queue = self._failures.setdefault(key, deque())
            queue.append(now)
            while queue and now - queue[0] > ADMIN_LOGIN_WINDOW:
                queue.popleft()
            while len(queue) > ADMIN_LOGIN_MAX_FAILURES * 2:
                queue.popleft()

    def clear_failures(self, key):
        with self._lock:
            self._failures.pop(key, None)


# ---------------------------------------------------------------------------
# SQLite index
# ---------------------------------------------------------------------------

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
    username TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    pack TEXT NOT NULL,
    offset INTEGER NOT NULL,
    raw_len INTEGER NOT NULL,
    stored_len INTEGER NOT NULL,
    crc32 INTEGER NOT NULL,
    PRIMARY KEY (username, sha256)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS packs (
    username TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    PRIMARY KEY (username, name)
) WITHOUT ROWID;
"""


class Database:
    def __init__(self, path):
        self.path = path
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(
            path,
            timeout=30,
            check_same_thread=False,
            isolation_level=None,
        )
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=FULL")
        self._conn.execute("PRAGMA busy_timeout=30000")
        self._conn.executescript(SCHEMA_SQL)

    def close(self):
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None

    def quick_check_ok(self):
        with self._lock:
            try:
                rows = self._conn.execute("PRAGMA quick_check").fetchall()
            except sqlite3.OperationalError:
                raise
            except sqlite3.Error:
                return False
            return len(rows) == 1 and rows[0][0] == "ok"

    def schema_ok(self):
        with self._lock:
            try:
                self._conn.execute(
                    "SELECT username, sha256, pack, offset, raw_len, stored_len, crc32 "
                    "FROM chunks LIMIT 1"
                ).fetchall()
                self._conn.execute(
                    "SELECT username, name, size FROM packs LIMIT 1"
                ).fetchall()
                self._conn.execute("SELECT key, value FROM meta LIMIT 1").fetchall()
            except sqlite3.OperationalError:
                raise
            except sqlite3.Error:
                return False
            return True

    def get_meta(self, key):
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM meta WHERE key=?", (key,)
            ).fetchone()
            return row[0] if row else None

    def set_meta(self, key, value):
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)",
                (key, value),
            )

    def is_initialized(self):
        return self.get_meta("schema_version") == "1"

    def chunk_record(self, user, sha):
        with self._lock:
            row = self._conn.execute(
                "SELECT pack, offset, raw_len, stored_len, crc32 "
                "FROM chunks WHERE username=? AND sha256=?",
                (user, sha),
            ).fetchone()
            if row is None:
                return None
            return {
                "pack": row[0],
                "offset": row[1],
                "raw_len": row[2],
                "stored_len": row[3],
                "crc32": row[4],
            }

    def chunk_exists(self, user, sha):
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM chunks WHERE username=? AND sha256=?",
                (user, sha),
            ).fetchone()
            return row is not None

    def chunk_sizes(self, user):
        with self._lock:
            rows = self._conn.execute(
                "SELECT sha256, raw_len FROM chunks WHERE username=?", (user,)
            ).fetchall()
            return {row[0]: row[1] for row in rows}

    def all_chunk_records(self, user):
        with self._lock:
            rows = self._conn.execute(
                "SELECT sha256, pack, offset, raw_len, stored_len, crc32 "
                "FROM chunks WHERE username=?",
                (user,),
            ).fetchall()
            return [
                {
                    "sha256": row[0],
                    "pack": row[1],
                    "offset": row[2],
                    "raw_len": row[3],
                    "stored_len": row[4],
                    "crc32": row[5],
                }
                for row in rows
            ]

    def pack_sizes(self, user):
        with self._lock:
            rows = self._conn.execute(
                "SELECT name, size FROM packs WHERE username=?", (user,)
            ).fetchall()
            return {row[0]: row[1] for row in rows}

    def chunk_pack_names(self, user):
        with self._lock:
            rows = self._conn.execute(
                "SELECT DISTINCT pack FROM chunks WHERE username=?", (user,)
            ).fetchall()
            return {row[0] for row in rows}

    def user_usage(self, user):
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*), COALESCE(SUM(raw_len), 0), COALESCE(SUM(stored_len), 0) "
                "FROM chunks WHERE username=?",
                (user,),
            ).fetchone()
            return {
                "chunks": row[0],
                "raw_bytes": row[1],
                "stored_bytes": row[2],
            }

    def _begin(self):
        self._conn.execute("BEGIN IMMEDIATE")

    def _commit(self):
        self._conn.execute("COMMIT")

    def _rollback(self):
        try:
            self._conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass

    def commit_records(self, user, pack, records, pack_size):
        rows = [
            (
                user,
                record["sha256"],
                pack,
                record["offset"],
                record["raw_len"],
                record["stored_len"],
                record["crc32"],
            )
            for record in records
        ]
        with self._lock:
            self._begin()
            try:
                self._conn.executemany(
                    "INSERT OR IGNORE INTO chunks"
                    "(username, sha256, pack, offset, raw_len, stored_len, crc32) "
                    "VALUES(?, ?, ?, ?, ?, ?, ?)",
                    rows,
                )
                self._conn.execute(
                    "INSERT OR REPLACE INTO packs(username, name, size) VALUES(?, ?, ?)",
                    (user, pack, pack_size),
                )
                self._commit()
            except BaseException:
                self._rollback()
                raise

    def replace_pack(self, user, pack, records, pack_size):
        rows = [
            (
                user,
                record["sha256"],
                pack,
                record["offset"],
                record["raw_len"],
                record["stored_len"],
                record["crc32"],
            )
            for record in records
        ]
        with self._lock:
            self._begin()
            try:
                self._conn.execute(
                    "DELETE FROM chunks WHERE username=? AND pack=?", (user, pack)
                )
                self._conn.executemany(
                    "INSERT OR IGNORE INTO chunks"
                    "(username, sha256, pack, offset, raw_len, stored_len, crc32) "
                    "VALUES(?, ?, ?, ?, ?, ?, ?)",
                    rows,
                )
                self._conn.execute(
                    "INSERT OR REPLACE INTO packs(username, name, size) VALUES(?, ?, ?)",
                    (user, pack, pack_size),
                )
                self._commit()
            except BaseException:
                self._rollback()
                raise

    def append_pack_records(self, user, pack, records, pack_size):
        rows = [
            (
                user,
                record["sha256"],
                pack,
                record["offset"],
                record["raw_len"],
                record["stored_len"],
                record["crc32"],
            )
            for record in records
        ]
        with self._lock:
            self._begin()
            try:
                self._conn.executemany(
                    "INSERT OR IGNORE INTO chunks"
                    "(username, sha256, pack, offset, raw_len, stored_len, crc32) "
                    "VALUES(?, ?, ?, ?, ?, ?, ?)",
                    rows,
                )
                self._conn.execute(
                    "INSERT OR REPLACE INTO packs(username, name, size) VALUES(?, ?, ?)",
                    (user, pack, pack_size),
                )
                self._commit()
            except BaseException:
                self._rollback()
                raise

    def delete_chunks(self, user, shas):
        if not shas:
            return
        with self._lock:
            self._begin()
            try:
                self._conn.executemany(
                    "DELETE FROM chunks WHERE username=? AND sha256=?",
                    [(user, sha) for sha in shas],
                )
                self._commit()
            except BaseException:
                self._rollback()
                raise

    def delete_pack(self, user, name):
        with self._lock:
            self._begin()
            try:
                self._conn.execute(
                    "DELETE FROM chunks WHERE username=? AND pack=?", (user, name)
                )
                self._conn.execute(
                    "DELETE FROM packs WHERE username=? AND name=?", (user, name)
                )
                self._commit()
            except BaseException:
                self._rollback()
                raise

    def delete_user_data(self, user):
        with self._lock:
            self._begin()
            try:
                self._conn.execute("DELETE FROM chunks WHERE username=?", (user,))
                self._conn.execute("DELETE FROM packs WHERE username=?", (user,))
                self._commit()
            except BaseException:
                self._rollback()
                raise

    def apply_repack(self, user, old_pack, new_packs, updates):
        with self._lock:
            self._begin()
            try:
                for sha, pack, offset in updates:
                    cursor = self._conn.execute(
                        "UPDATE chunks SET pack=?, offset=? "
                        "WHERE username=? AND sha256=?",
                        (pack, offset, user, sha),
                    )
                    if cursor.rowcount != 1:
                        raise ApiError(
                            500,
                            "index_inconsistent",
                            f"chunk {sha} moved out of the index during GC",
                        )
                self._conn.execute(
                    "DELETE FROM packs WHERE username=? AND name=?", (user, old_pack)
                )
                for name, size in new_packs:
                    self._conn.execute(
                        "INSERT OR REPLACE INTO packs(username, name, size) VALUES(?, ?, ?)",
                        (user, name, size),
                    )
                self._commit()
            except BaseException:
                self._rollback()
                raise

    def rebuild_all(self, data, schema_version="1"):
        with self._lock:
            self._begin()
            try:
                self._conn.execute("DELETE FROM chunks")
                self._conn.execute("DELETE FROM packs")
                for user, bundle in data.items():
                    for record in bundle["records"]:
                        self._conn.execute(
                            "INSERT OR IGNORE INTO chunks"
                            "(username, sha256, pack, offset, raw_len, stored_len, crc32) "
                            "VALUES(?, ?, ?, ?, ?, ?, ?)",
                            (
                                user,
                                record["sha256"],
                                record["pack"],
                                record["offset"],
                                record["raw_len"],
                                record["stored_len"],
                                record["crc32"],
                            ),
                        )
                    for name, size in bundle["packs"].items():
                        self._conn.execute(
                            "INSERT OR REPLACE INTO packs(username, name, size) VALUES(?, ?, ?)",
                            (user, name, size),
                        )
                self._conn.execute(
                    "INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)",
                    (schema_version,),
                )
                self._commit()
            except BaseException:
                self._rollback()
                raise


# ---------------------------------------------------------------------------
# Pack writer
# ---------------------------------------------------------------------------


class PackWriter:
    def __init__(self, store, user):
        self.store = store
        self.user = user
        self.packs_dir = store.packs_dir(user)
        store._ensure_user_dirs(user)
        self._file = None
        self._name = None
        self._offset = 0
        self._committed_offset = 0
        self._pending = []
        self._pending_shas = set()
        self._pending_bytes = 0
        self._last_append = 0.0

    def exists(self, sha):
        if sha in self._pending_shas:
            return True
        return self.store.db.chunk_exists(self.user, sha)

    def has_pending(self, sha):
        return sha in self._pending_shas

    def _open_new_locked(self):
        name = self.store._next_pack_name_locked(self.user)
        path = self.store.pack_path(self.user, name)
        self._file = open(path, "xb")
        chmod_quiet(path, 0o600)
        fsync_dir(self.packs_dir)
        self._name = name
        self._offset = 0
        self._committed_offset = 0
        self._pending = []
        self._pending_shas = set()
        self._pending_bytes = 0
        self._last_append = 0.0

    def _ensure_open_locked(self):
        if self._file is not None:
            return
        packs = self.store.db.pack_sizes(self.user)
        if not packs:
            self._open_new_locked()
            return
        name = max(packs, key=self.store._pack_sort_key)
        path = self.store.pack_path(self.user, name)
        try:
            actual_size = os.path.getsize(path)
        except OSError:
            raise ApiError(
                500,
                "index_inconsistent",
                f"index references missing pack {name}",
            )
        expected_size = packs[name]
        if actual_size != expected_size:
            raise ApiError(
                500,
                "index_inconsistent",
                f"pack {name} size does not match the index",
            )
        self._file = open(path, "ab")
        self._name = name
        self._offset = expected_size
        self._committed_offset = expected_size
        self._pending = []
        self._pending_shas = set()
        self._pending_bytes = 0
        self._last_append = 0.0

    def _rollback_pending_locked(self):
        try:
            self._file.truncate(self._committed_offset)
            self._file.seek(self._committed_offset)
        except OSError:
            pass
        self._offset = self._committed_offset
        self._pending = []
        self._pending_shas = set()
        self._pending_bytes = 0
        self._last_append = 0.0

    def flush(self):
        if not self._pending:
            return
        try:
            self._file.flush()
            os.fsync(self._file.fileno())
        except OSError as exc:
            self._rollback_pending_locked()
            raise ApiError(
                507,
                "write_failed",
                f"failed to sync chunk data ({exc.__class__.__name__})",
            )

        self._committed_offset = self._offset
        records = list(self._pending)
        self.store.db.commit_records(self.user, self._name, records, self._offset)
        self._pending = []
        self._pending_shas = set()
        self._pending_bytes = 0
        self._last_append = 0.0

    def flush_if_old(self, max_age):
        if self._pending and time.monotonic() - self._last_append >= max_age:
            self.flush()

    def _rotate_locked(self):
        self.flush()
        if self._file is not None:
            self._file.close()
            self._file = None
        self._open_new_locked()

    def append(self, raw, sha):
        self._ensure_open_locked()
        compressed = zlib.compress(raw, 6)
        if len(compressed) > MAX_STORED_SIZE:
            raise ApiError(500, "compression_error", "compressed chunk exceeds the record limit")
        crc = zlib.crc32(compressed) & 0xFFFFFFFF
        header = PACK_HEADER.pack(
            PACK_MAGIC,
            bytes.fromhex(sha),
            len(raw),
            len(compressed),
            crc,
        )
        record_size = len(header) + len(compressed)
        if self._offset > 0 and self._offset + record_size > self.store.pack_max_size:
            self._rotate_locked()

        start = self._offset
        try:
            self._file.write(header)
            self._file.write(compressed)
        except OSError:
            try:
                self._file.truncate(start)
                self._file.seek(start)
            except OSError:
                pass
            self._offset = start
            raise ApiError(507, "write_failed", "failed to write chunk data to disk")

        self._offset += record_size
        self._pending.append(
            {
                "sha256": sha,
                "offset": start + PACK_HEADER.size,
                "raw_len": len(raw),
                "stored_len": len(compressed),
                "crc32": crc,
            }
        )
        self._pending_shas.add(sha)
        self._pending_bytes += record_size
        self._last_append = time.monotonic()
        if self._pending_bytes >= self.store.fsync_batch_bytes:
            self.flush()
        return True

    def close(self):
        try:
            self.flush()
        finally:
            if self._file is not None:
                self._file.close()
                self._file = None


# ---------------------------------------------------------------------------
# Backup store
# ---------------------------------------------------------------------------


class BackupStore:
    def __init__(
        self,
        data_dir,
        *,
        verbose=False,
        start_flusher=True,
        pack_max_size=PACK_MAX_SIZE,
        fsync_batch_bytes=FSYNC_BATCH_BYTES,
        min_free_bytes=MIN_FREE_BYTES,
        auto_gc_keep=None,
    ):
        self.data_dir = os.path.abspath(data_dir)
        self.users_dir = os.path.join(self.data_dir, "users")
        self.verbose = verbose
        self.pack_max_size = pack_max_size
        self.fsync_batch_bytes = fsync_batch_bytes
        self.min_free_bytes = min_free_bytes
        self.auto_gc_keep = auto_gc_keep
        self._locks_guard = threading.Lock()
        self._locks = {}
        self._writers_guard = threading.Lock()
        self._writers = {}
        self._closed = False
        self._gc_lock = threading.Lock()
        self._gc_event = threading.Event()
        self._gc_stop = threading.Event()
        self._gc_pending_guard = threading.Lock()
        self._gc_pending = set()
        self._protected_guard = threading.Lock()
        self._protected = {}
        os.makedirs(self.users_dir, exist_ok=True)
        chmod_quiet(self.data_dir, 0o700)
        chmod_quiet(self.users_dir, 0o700)
        self.users = UserStore(self.data_dir, verbose=verbose)
        self.admin_auth = AdminAuth(self.data_dir, verbose=verbose)
        self.db = None
        self._open_index()
        try:
            self._repair_index()
        except BaseException:
            self.db.close()
            raise
        self._stop_event = threading.Event()
        self._flusher = None
        if start_flusher:
            self._flusher = threading.Thread(
                target=self._flush_loop,
                name="obk-flusher",
                daemon=True,
            )
            self._flusher.start()
        self._gc_thread = None
        if auto_gc_keep is not None and auto_gc_keep > 0:
            self._gc_thread = threading.Thread(
                target=self._auto_gc_loop,
                name="obk-gc",
                daemon=True,
            )
            self._gc_thread.start()

    # -- logging ---------------------------------------------------------

    def _log(self, message):
        if self.verbose:
            sys.stderr.write(f"[{now_iso()}] {message}\n")
            sys.stderr.flush()

    def _warn(self, message):
        sys.stderr.write(f"[{now_iso()}] {message}\n")
        sys.stderr.flush()

    # -- paths -----------------------------------------------------------

    def user_dir(self, user):
        return os.path.join(self.users_dir, user)

    def packs_dir(self, user):
        return os.path.join(self.user_dir(user), "packs")

    def snapshots_dir(self, user):
        return os.path.join(self.user_dir(user), "snapshots")

    def pack_path(self, user, name):
        if not PACK_FILE_RE.match(name):
            raise ApiError(500, "index_inconsistent", "invalid pack name in the index")
        return os.path.join(self.packs_dir(user), name)

    def snapshot_path(self, user, snapshot_id):
        snapshot_id = validate_snapshot_id(snapshot_id)
        return os.path.join(self.snapshots_dir(user), snapshot_id + ".json")

    def _ensure_user_dirs(self, user):
        for directory in (
            self.user_dir(user),
            self.packs_dir(user),
            self.snapshots_dir(user),
        ):
            os.makedirs(directory, exist_ok=True)
            chmod_quiet(directory, 0o700)

    # -- index boot / repair ---------------------------------------------

    def _open_index(self):
        db_path = os.path.join(self.data_dir, "index.sqlite3")
        db = None
        try:
            db = Database(db_path)
            if not db.quick_check_ok() or not db.schema_ok():
                raise sqlite3.DatabaseError("index validation failed")
        except sqlite3.OperationalError as exc:
            if db is not None:
                db.close()
            message = str(exc).lower()
            if "locked" in message or "busy" in message:
                raise ApiError(
                    500,
                    "index_locked",
                    "index.sqlite3 is locked by another process",
                )
            self._quarantine_index()
            db = Database(db_path)
        except sqlite3.Error:
            if db is not None:
                db.close()
            self._quarantine_index()
            db = Database(db_path)

        self.db = db
        chmod_quiet(db_path, 0o600)
        try:
            if not db.is_initialized():
                self._rebuild_all()
        except BaseException:
            db.close()
            raise

    def _quarantine_index(self):
        db_path = os.path.join(self.data_dir, "index.sqlite3")
        suffix = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        target = f"{db_path}.corrupt-{suffix}"
        if os.path.exists(db_path):
            os.replace(db_path, target)
            self._log(f"quarantined damaged index at {os.path.basename(target)}")
        for extra in ("-wal", "-shm"):
            try:
                os.unlink(db_path + extra)
            except OSError:
                pass

    def _data_user_dirs(self):
        if not os.path.isdir(self.users_dir):
            return []
        result = []
        for name in sorted(os.listdir(self.users_dir)):
            if not USER_RE.match(name) or name in (".", ".."):
                continue
            path = os.path.join(self.users_dir, name)
            if os.path.isdir(path):
                result.append(name)
        return result

    def _list_pack_files(self, user):
        directory = self.packs_dir(user)
        result = {}
        if not os.path.isdir(directory):
            return result
        for name in sorted(os.listdir(directory)):
            if not PACK_FILE_RE.match(name):
                continue
            path = os.path.join(directory, name)
            if os.path.isfile(path):
                result[name] = path
        return result

    def _disk_pack_sizes(self, user):
        result = {}
        for name, path in self._list_pack_files(user).items():
            try:
                result[name] = os.path.getsize(path)
            except OSError:
                continue
        return result

    @staticmethod
    def _pack_sort_key(name):
        match = PACK_NUM_RE.match(name)
        if match:
            return (0, int(match.group(1)), name)
        return (1, 0, name)

    def _next_pack_name_locked(self, user):
        used = set(self._disk_pack_sizes(user)) | set(self.db.pack_sizes(user))
        sequence = 1
        for name in used:
            match = PACK_NUM_RE.match(name)
            if match:
                sequence = max(sequence, int(match.group(1)) + 1)
        while True:
            candidate = f"{sequence:08d}.pack"
            if candidate not in used:
                return candidate
            sequence += 1

    def _rebuild_all(self):
        data = {}
        for user in self._data_user_dirs():
            records = []
            seen = set()
            packs = {}
            for name, path in self._list_pack_files(user).items():
                result = scan_pack(path, 0, allow_crc_errors=True)
                if result["truncated"] or result["framing_error"]:
                    safe_end = result["last_good_end"]
                else:
                    safe_end = result["scanned_end"]
                if result["file_size"] > safe_end:
                    try:
                        truncate_file(path, safe_end)
                    except OSError as exc:
                        raise ApiError(
                            500,
                            "index_rebuild_failed",
                            f"cannot truncate damaged pack {name} ({exc.__class__.__name__})",
                        )
                if result["crc_errors"] or result["framing_error"]:
                    self._log(
                        f"rebuild: user={user} pack={name} skipped "
                        f"{result['crc_errors']} CRC-failed record(s)"
                    )
                packs[name] = safe_end
                for record in result["records"]:
                    sha = record["sha256"]
                    if sha in seen:
                        continue
                    seen.add(sha)
                    records.append(
                        {
                            "sha256": sha,
                            "pack": name,
                            "offset": record["offset"],
                            "raw_len": record["raw_len"],
                            "stored_len": record["stored_len"],
                            "crc32": record["crc32"],
                        }
                    )
            data[user] = {"packs": packs, "records": records}
        self.db.rebuild_all(data, schema_version="1")
        self._log(f"rebuilt index for {len(data)} user(s)")

    def _rebuild_pack(self, user, name, path):
        result = scan_pack(path, 0, allow_crc_errors=True)
        if result["truncated"] or result["framing_error"]:
            safe_end = result["last_good_end"]
        else:
            safe_end = result["scanned_end"]
        if result["file_size"] > safe_end:
            truncate_file(path, safe_end)
        self.db.replace_pack(user, name, result["records"], safe_end)
        if result["crc_errors"] or result["framing_error"]:
            self._log(
                f"repaired pack: user={user} pack={name} "
                f"crc_errors={result['crc_errors']} "
                f"framing_error={result['framing_error'] or 'none'}"
            )

    def _recover_pack_tail(self, user, name, path, committed):
        result = scan_pack(path, committed, allow_crc_errors=False)
        if (
            result["truncated"]
            or result["framing_error"]
            or result["crc_errors"]
        ):
            new_size = result["last_good_end"]
        else:
            new_size = result["scanned_end"]
        if result["file_size"] > new_size:
            truncate_file(path, new_size)
        self.db.append_pack_records(user, name, result["records"], new_size)
        if result["records"]:
            self._log(
                f"recovered {len(result['records'])} chunk record(s) from pack tail "
                f"user={user} pack={name}"
            )

    def _repair_index(self):
        for user in self._data_user_dirs():
            with self._user_lock(user):
                disk = self._disk_pack_sizes(user)
                db_packs = self.db.pack_sizes(user)
                for name in sorted(self.db.chunk_pack_names(user) - set(disk)):
                    self._log(
                        f"index cleanup: dropping chunks from missing pack "
                        f"user={user} pack={name}"
                    )
                    self.db.delete_pack(user, name)
                for name in sorted(set(db_packs) - set(disk)):
                    self.db.delete_pack(user, name)
                for name, size in sorted(disk.items()):
                    committed = db_packs.get(name)
                    path = self.pack_path(user, name)
                    if committed is None:
                        self._rebuild_pack(user, name, path)
                    elif size < committed:
                        self._log(
                            f"pack shrank below its committed size, rebuilding "
                            f"user={user} pack={name}"
                        )
                        self._rebuild_pack(user, name, path)
                    elif size > committed:
                        self._recover_pack_tail(user, name, path, committed)

    # -- locking / writers ------------------------------------------------

    def _user_lock(self, user):
        with self._locks_guard:
            lock = self._locks.get(user)
            if lock is None:
                lock = threading.RLock()
                self._locks[user] = lock
            return lock

    def _get_writer_locked(self, user):
        with self._writers_guard:
            writer = self._writers.get(user)
            if writer is not None:
                return writer
            writer = PackWriter(self, user)
            self._writers[user] = writer
            return writer

    def _close_writer_locked(self, user):
        with self._writers_guard:
            writer = self._writers.pop(user, None)
        if writer is not None:
            writer.close()

    def _flush_user_locked(self, user):
        with self._writers_guard:
            writer = self._writers.get(user)
        if writer is not None:
            writer.flush()

    def flush_user(self, user):
        with self._user_lock(user):
            self._flush_user_locked(user)

    def _flush_loop(self):
        while not self._stop_event.wait(FLUSHER_INTERVAL):
            with self._writers_guard:
                users = list(self._writers)
            for user in users:
                try:
                    with self._user_lock(user):
                        with self._writers_guard:
                            writer = self._writers.get(user)
                        if writer is not None:
                            writer.flush_if_old(PENDING_FLUSH_AGE)
                except Exception as exc:  # keep the background thread alive
                    self._log(f"background flush failed: {exc.__class__.__name__}")

    # -- upload protection / automatic GC --------------------------------

    def _protect_upload(self, user, sha):
        with self._protected_guard:
            self._protected.setdefault(user, set()).add(sha)

    def _unprotect_uploads(self, user, shas):
        with self._protected_guard:
            bucket = self._protected.get(user)
            if bucket is None:
                return
            bucket.difference_update(shas)
            if not bucket:
                self._protected.pop(user, None)

    def _clear_protected(self, user):
        with self._protected_guard:
            self._protected.pop(user, None)

    def _protected_snapshot(self, user):
        with self._protected_guard:
            return set(self._protected.get(user, ()))

    def schedule_gc(self, user):
        if self._gc_thread is None or self._closed:
            return
        with self._gc_pending_guard:
            self._gc_pending.add(user)
        self._gc_event.set()

    def _auto_gc_loop(self):
        while not self._gc_stop.is_set():
            if not self._gc_event.wait(1.0):
                continue
            self._gc_event.clear()
            if self._gc_stop.is_set():
                return
            with self._gc_pending_guard:
                users = sorted(self._gc_pending)
                self._gc_pending.clear()
            for user in users:
                if self._gc_stop.is_set():
                    return
                try:
                    self._auto_gc_user(user)
                except Exception as exc:
                    self._warn(
                        f"automatic GC failed for user {user}: "
                        f"{exc.__class__.__name__}: {exc}"
                    )

    def _auto_gc_user(self, user):
        with self._gc_lock:
            return self._gc_impl(
                self.auto_gc_keep,
                dry_run=False,
                users=[user],
                protect_uploads=True,
            )

    # -- chunk operations -------------------------------------------------

    def _check_free_space(self):
        try:
            free = shutil.disk_usage(self.data_dir).free
        except OSError as exc:
            raise ApiError(
                500,
                "storage_check_failed",
                f"cannot determine free disk space ({exc.__class__.__name__})",
            )
        if free < self.min_free_bytes:
            raise ApiError(
                507,
                "insufficient_storage",
                "free disk space is below the 2 GiB safety margin",
            )

    def put_chunk(self, user, raw, sha):
        with self._user_lock(user):
            writer = self._get_writer_locked(user)
            if writer.exists(sha):
                self._protect_upload(user, sha)
                return False
            self._check_free_space()
            created = writer.append(raw, sha)
            if created:
                self._protect_upload(user, sha)
            return created

    def chunk_exists(self, user, sha):
        with self._user_lock(user):
            with self._writers_guard:
                writer = self._writers.get(user)
            if writer is not None and writer.has_pending(sha):
                self._protect_upload(user, sha)
                return True
            exists = self.db.chunk_exists(user, sha)
            if exists:
                self._protect_upload(user, sha)
            return exists

    def _read_chunk_record(self, user, sha, record):
        if not (
            isinstance(record.get("pack"), str)
            and PACK_FILE_RE.match(record["pack"])
            and isinstance(record.get("offset"), int)
            and record["offset"] >= 0
            and isinstance(record.get("raw_len"), int)
            and 0 <= record["raw_len"] <= MAX_CHUNK_SIZE
            and isinstance(record.get("stored_len"), int)
            and 1 <= record["stored_len"] <= MAX_STORED_SIZE
            and isinstance(record.get("crc32"), int)
        ):
            raise ApiError(500, "chunk_corrupt", f"chunk {sha} has invalid index metadata")
        path = self.pack_path(user, record["pack"])
        try:
            file_size = os.path.getsize(path)
        except OSError:
            raise ApiError(
                500,
                "chunk_corrupt",
                f"chunk {sha} is stored in a missing pack",
            )
        if record["offset"] + record["stored_len"] > file_size:
            raise ApiError(
                500,
                "chunk_corrupt",
                f"chunk {sha} points outside pack {record['pack']}",
            )
        try:
            with open(path, "rb") as handle:
                handle.seek(record["offset"])
                payload = handle.read(record["stored_len"])
        except OSError as exc:
            raise ApiError(
                500,
                "chunk_corrupt",
                f"cannot read chunk {sha} from pack {record['pack']} "
                f"({exc.__class__.__name__})",
            )
        if len(payload) != record["stored_len"]:
            raise ApiError(
                500,
                "chunk_corrupt",
                f"chunk {sha} is truncated in pack {record['pack']}",
            )
        if (zlib.crc32(payload) & 0xFFFFFFFF) != record["crc32"]:
            raise ApiError(
                500,
                "chunk_corrupt",
                f"chunk {sha} failed CRC verification in pack {record['pack']}",
            )
        try:
            raw = decompress_chunk(payload, record["raw_len"])
        except zlib.error:
            raise ApiError(
                500,
                "chunk_corrupt",
                f"chunk {sha} failed decompression in pack {record['pack']}",
            )
        if len(raw) != record["raw_len"] or sha256_hex(raw) != sha:
            raise ApiError(
                500,
                "chunk_corrupt",
                f"chunk {sha} failed SHA-256 verification in pack {record['pack']}",
            )
        return raw

    def get_chunk(self, user, sha):
        with self._user_lock(user):
            self._flush_user_locked(user)
            record = self.db.chunk_record(user, sha)
            if record is None:
                raise ApiError(404, "chunk_not_found", f"chunk {sha} is not stored")
            return self._read_chunk_record(user, sha, record)

    # -- snapshots --------------------------------------------------------

    def _read_manifest_file(self, path):
        try:
            size = os.path.getsize(path)
        except OSError:
            raise ApiError(404, "snapshot_not_found", "snapshot does not exist")
        if size > MAX_MANIFEST_SIZE:
            raise ApiError(500, "snapshot_corrupt", "snapshot manifest is too large")
        try:
            with open(path, "rb") as handle:
                raw = handle.read()
            value = json.loads(raw.decode("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(500, "snapshot_corrupt", "snapshot manifest cannot be read")
        if not isinstance(value, dict):
            raise ApiError(500, "snapshot_corrupt", "snapshot manifest is invalid")
        return value

    def _snapshot_entries_locked(self, user, strict=False):
        directory = self.snapshots_dir(user)
        entries = []
        if not os.path.isdir(directory):
            return entries
        for filename in sorted(os.listdir(directory)):
            if not filename.endswith(".json"):
                continue
            snapshot_id = filename[:-5]
            if (
                not SNAPSHOT_ID_RE.match(snapshot_id)
                or snapshot_id in (".", "..")
            ):
                continue
            path = os.path.join(directory, filename)
            try:
                raw_manifest = self._read_manifest_file(path)
                created = parse_iso8601(raw_manifest.get("created_at"))
                manifest = normalize_manifest(raw_manifest) if strict else raw_manifest
                if strict and manifest["id"] != snapshot_id:
                    raise ApiError(
                        500,
                        "snapshot_corrupt",
                        "manifest id does not match its filename",
                    )
            except ApiError as exc:
                if strict:
                    raise ApiError(
                        500,
                        "snapshot_corrupt",
                        f"snapshot {snapshot_id} cannot be used for GC ({exc.code})",
                    )
                self._log(
                    f"snapshot list: skipping unreadable snapshot "
                    f"user={user} id={snapshot_id} ({exc.code})"
                )
                continue
            entries.append(
                {
                    "id": snapshot_id,
                    "path": path,
                    "manifest": manifest,
                    "created": created,
                }
            )
        entries.sort(key=lambda item: (item["created"], item["id"]), reverse=True)
        return entries

    @staticmethod
    def _summary_from_manifest(manifest, snapshot_id=None):
        raw_files = manifest.get("files")
        files = []
        if isinstance(raw_files, list):
            for item in raw_files:
                if not isinstance(item, dict):
                    continue
                files.append(
                    {
                        "path": item.get("path"),
                        "size": item.get("size"),
                        "sha256": item.get("sha256"),
                    }
                )
        return {
            "id": snapshot_id if snapshot_id is not None else manifest.get("id"),
            "created_at": manifest.get("created_at"),
            "total_bytes": manifest.get("total_bytes"),
            "files": files,
            "file_count": len(files),
        }

    def _snapshot_summaries_locked(self, user):
        return [
            self._summary_from_manifest(entry["manifest"], entry["id"])
            for entry in self._snapshot_entries_locked(user)
        ]

    def create_snapshot(self, user, payload):
        manifest = normalize_manifest(payload)
        with self._user_lock(user):
            self._flush_user_locked(user)
            path = self.snapshot_path(user, manifest["id"])
            if os.path.exists(path):
                raise ApiError(
                    409,
                    "snapshot_exists",
                    f"snapshot {manifest['id']} already exists",
                )
            sizes = self.db.chunk_sizes(user)
            for item in manifest["files"]:
                total = 0
                for chunk in item["chunks"]:
                    if chunk not in sizes:
                        raise ApiError(
                            400,
                            "missing_chunk",
                            f"chunk {chunk} is not stored; upload it before creating a snapshot",
                        )
                    total += sizes[chunk]
                if total != item["size"]:
                    raise ApiError(
                        400,
                        "invalid_manifest",
                        f"file {item['path']} size does not match its chunks",
                    )
            self._ensure_user_dirs(user)
            atomic_write_json(path, manifest, mode=0o600)
            self._unprotect_uploads(
                user,
                [
                    chunk
                    for item in manifest["files"]
                    for chunk in item["chunks"]
                ],
            )
        self.schedule_gc(user)
        return manifest

    def list_snapshots(self, user):
        with self._user_lock(user):
            return self._snapshot_summaries_locked(user)

    def get_snapshot(self, user, snapshot_id):
        with self._user_lock(user):
            path = self.snapshot_path(user, snapshot_id)
            if not os.path.exists(path):
                raise ApiError(
                    404,
                    "snapshot_not_found",
                    f"snapshot {snapshot_id} does not exist",
                )
            return self._read_manifest_file(path)

    def delete_snapshot(self, user, snapshot_id):
        with self._user_lock(user):
            path = self.snapshot_path(user, snapshot_id)
            try:
                os.unlink(path)
            except FileNotFoundError:
                return
            except OSError as exc:
                raise ApiError(
                    500,
                    "snapshot_delete_failed",
                    f"cannot delete snapshot ({exc.__class__.__name__})",
                )

    # -- usage / user data ------------------------------------------------

    def user_usage(self, user):
        with self._user_lock(user):
            self._flush_user_locked(user)
            entries = self._snapshot_entries_locked(user)
            chunk_usage = self.db.user_usage(user)
            pack_bytes = sum(self._disk_pack_sizes(user).values())
            return {
                "snapshots": len(entries),
                "snapshot_bytes": sum(
                    int(entry["manifest"].get("total_bytes") or 0)
                    for entry in entries
                    if isinstance(entry["manifest"].get("total_bytes"), int)
                ),
                "latest_snapshot": (
                    entries[0]["manifest"].get("created_at") if entries else ""
                ),
                "chunks": chunk_usage["chunks"],
                "raw_bytes": chunk_usage["raw_bytes"],
                "stored_bytes": chunk_usage["stored_bytes"],
                "pack_bytes": pack_bytes,
            }

    def delete_user_data(self, user):
        with self._user_lock(user):
            self._close_writer_locked(user)
            self._clear_protected(user)
            with self._gc_pending_guard:
                self._gc_pending.discard(user)
            self.db.delete_user_data(user)
            directory = self.user_dir(user)
            try:
                shutil.rmtree(directory)
            except FileNotFoundError:
                pass
            except OSError as exc:
                raise ApiError(
                    500,
                    "user_delete_failed",
                    f"cannot delete user data ({exc.__class__.__name__})",
                )

    # -- garbage collection ----------------------------------------------

    def gc(self, keep, dry_run=False):
        with self._gc_lock:
            return self._gc_impl(keep, dry_run=dry_run)

    def _gc_impl(self, keep, dry_run=False, users=None, protect_uploads=False):
        if not isinstance(keep, int) or isinstance(keep, bool) or keep < 0:
            raise ApiError(400, "invalid_arguments", "keep must be a non-negative integer")

        result = {
            "dry_run": bool(dry_run),
            "keep": keep,
            "users": {},
            "totals": {
                "snapshots_kept": 0,
                "snapshots_deleted": 0,
                "chunks_deleted": 0,
                "packs_repacked": 0,
                "packs_removed": 0,
                "bytes_freed": 0,
            },
        }

        selected_users = users if users is not None else self.users.list_names()
        for user in selected_users:
            with self._user_lock(user):
                self._flush_user_locked(user)
                entries = self._snapshot_entries_locked(user, strict=True)
                kept = entries[:keep]
                dropped = entries[keep:]
                referenced = set()
                for entry in kept:
                    manifest = entry["manifest"]
                    raw_files = manifest.get("files")
                    if not isinstance(raw_files, list):
                        continue
                    for item in raw_files:
                        if not isinstance(item, dict):
                            continue
                        chunks = item.get("chunks")
                        if not isinstance(chunks, list):
                            continue
                        for chunk in chunks:
                            if isinstance(chunk, str):
                                referenced.add(chunk.lower())

                protected = (
                    self._protected_snapshot(user) if protect_uploads else set()
                )
                keep_chunks = referenced | protected
                all_records = self.db.all_chunk_records(user)
                live_records = [
                    record for record in all_records if record["sha256"] in keep_chunks
                ]
                unreferenced = [
                    record for record in all_records if record["sha256"] not in keep_chunks
                ]
                by_pack = {}
                for record in live_records:
                    by_pack.setdefault(record["pack"], []).append(record)

                user_stats = {
                    "snapshots_kept": len(kept),
                    "snapshots_deleted": len(dropped),
                    "chunks_deleted": len(unreferenced),
                    "packs_repacked": 0,
                    "packs_removed": 0,
                    "bytes_freed": 0,
                }

                if dry_run:
                    for name, size in sorted(self._disk_pack_sizes(user).items()):
                        records = by_pack.get(name, [])
                        live_bytes = sum(
                            PACK_HEADER.size + record["stored_len"]
                            for record in records
                        )
                        garbage = size - live_bytes
                        if size == 0:
                            user_stats["packs_removed"] += 1
                            continue
                        if garbage < 0:
                            garbage = 0
                        if garbage / size >= GC_GARBAGE_RATIO:
                            if records:
                                user_stats["packs_repacked"] += 1
                            else:
                                user_stats["packs_removed"] += 1
                            user_stats["bytes_freed"] += garbage
                    for name in sorted(set(self.db.pack_sizes(user)) - set(self._disk_pack_sizes(user))):
                        user_stats["packs_removed"] += 1
                else:
                    for entry in dropped:
                        try:
                            os.unlink(entry["path"])
                        except FileNotFoundError:
                            pass
                        except OSError as exc:
                            raise ApiError(
                                500,
                                "gc_failed",
                                f"cannot delete snapshot {entry['id']} "
                                f"({exc.__class__.__name__})",
                            )
                    if unreferenced:
                        removed_shas = [
                            record["sha256"] for record in unreferenced
                        ]
                        self.db.delete_chunks(user, removed_shas)
                        if not protect_uploads:
                            self._unprotect_uploads(user, removed_shas)
                    self._close_writer_locked(user)

                    disk = self._disk_pack_sizes(user)
                    for name in sorted(set(self.db.pack_sizes(user)) - set(disk)):
                        self._log(
                            f"gc: dropping index rows for missing pack "
                            f"user={user} pack={name}"
                        )
                        self.db.delete_pack(user, name)
                        user_stats["packs_removed"] += 1
                    for name, size in sorted(disk.items()):
                        records = by_pack.get(name, [])
                        live_bytes = sum(
                            PACK_HEADER.size + record["stored_len"]
                            for record in records
                        )
                        garbage = size - live_bytes
                        force = garbage < 0
                        if force:
                            garbage = 0
                        path = os.path.join(self.packs_dir(user), name)
                        if size == 0:
                            self.db.delete_pack(user, name)
                            try:
                                os.unlink(path)
                            except OSError:
                                pass
                            user_stats["packs_removed"] += 1
                            continue
                        if not force and garbage / size < GC_GARBAGE_RATIO:
                            continue
                        if not records:
                            self.db.delete_pack(user, name)
                            try:
                                os.unlink(path)
                            except OSError as exc:
                                self._log(
                                    f"gc: cannot remove empty pack {name} "
                                    f"({exc.__class__.__name__})"
                                )
                            user_stats["packs_removed"] += 1
                            user_stats["bytes_freed"] += size
                            continue
                        freed = self._repack_pack_locked(user, name, records, size)
                        user_stats["packs_repacked"] += 1
                        user_stats["bytes_freed"] += freed

                result["users"][user] = user_stats
                for key, value in user_stats.items():
                    result["totals"][key] += value

        return result

    def _repack_pack_locked(self, user, old_name, records, old_size):
        packs_dir = self.packs_dir(user)
        old_path = self.pack_path(user, old_name)
        records = sorted(records, key=lambda item: item["offset"])

        new_files = []
        updates = []
        current = None
        current_size = 0

        def finish_current():
            nonlocal current
            if current is not None:
                current["size"] = current_size
                current["handle"].flush()
                os.fsync(current["handle"].fileno())
                current["handle"].close()
                current = None

        try:
            with open(old_path, "rb") as source:
                for record in records:
                    source.seek(record["offset"])
                    payload = source.read(record["stored_len"])
                    if (
                        len(payload) != record["stored_len"]
                        or (zlib.crc32(payload) & 0xFFFFFFFF) != record["crc32"]
                    ):
                        raise ApiError(
                            500,
                            "pack_corrupt",
                            f"pack {old_name} failed CRC verification during GC",
                        )
                    record_size = PACK_HEADER.size + len(payload)
                    if current is not None and current_size + record_size > self.pack_max_size:
                        finish_current()
                    if current is None:
                        name = self._next_pack_name_locked(user)
                        path = os.path.join(packs_dir, name)
                        handle = open(path, "xb")
                        chmod_quiet(path, 0o600)
                        current = {"name": name, "path": path, "handle": handle, "size": 0}
                        new_files.append(current)
                        current_size = 0
                    header = PACK_HEADER.pack(
                        PACK_MAGIC,
                        bytes.fromhex(record["sha256"]),
                        record["raw_len"],
                        record["stored_len"],
                        record["crc32"],
                    )
                    offset = current_size + PACK_HEADER.size
                    current["handle"].write(header)
                    current["handle"].write(payload)
                    current_size += record_size
                    updates.append((record["sha256"], current["name"], offset))
            finish_current()
            fsync_dir(packs_dir)
        except BaseException:
            if current is not None and not current["handle"].closed:
                try:
                    current["handle"].close()
                except OSError:
                    pass
            for item in new_files:
                try:
                    os.unlink(item["path"])
                except OSError:
                    pass
            raise

        new_pack_sizes = [(item["name"], item["size"]) for item in new_files]
        try:
            self.db.apply_repack(user, old_name, new_pack_sizes, updates)
        except BaseException:
            for item in new_files:
                try:
                    os.unlink(item["path"])
                except OSError:
                    pass
            raise

        try:
            os.unlink(old_path)
        except FileNotFoundError:
            pass
        except OSError as exc:
            self._log(
                f"gc: cannot remove old pack {old_name} "
                f"({exc.__class__.__name__}); it will be cleaned up later"
            )
        fsync_dir(packs_dir)
        return max(0, old_size - sum(size for _, size in new_pack_sizes))

    # -- lifecycle --------------------------------------------------------

    def close(self):
        if self._closed:
            return
        self._closed = True
        self._gc_stop.set()
        self._gc_event.set()
        if self._gc_thread is not None and self._gc_thread.is_alive():
            self._gc_thread.join()
        self._stop_event.set()
        if self._flusher is not None and self._flusher.is_alive():
            self._flusher.join(timeout=5)
        with self._writers_guard:
            users = list(self._writers)
        for user in users:
            with self._user_lock(user):
                self._close_writer_locked(user)
        if self.db is not None:
            self.db.close()


# ---------------------------------------------------------------------------
# Read-only verification
# ---------------------------------------------------------------------------


def _verify_user_dirs(data_dir):
    users_dir = os.path.join(data_dir, "users")
    if not os.path.isdir(users_dir):
        return []
    result = []
    for name in sorted(os.listdir(users_dir)):
        if not USER_RE.match(name) or name in (".", ".."):
            continue
        if os.path.isdir(os.path.join(users_dir, name)):
            result.append(name)
    return result


def _verify_read_manifest(path):
    try:
        size = os.path.getsize(path)
        if size > MAX_MANIFEST_SIZE:
            raise ApiError(500, "snapshot_corrupt", "manifest is too large")
        with open(path, "rb") as handle:
            raw = handle.read()
        value = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise ApiError(500, "snapshot_corrupt", "manifest cannot be read")
    if not isinstance(value, dict):
        raise ApiError(500, "snapshot_corrupt", "manifest is not an object")
    return value


def verify_pack_file(path, name):
    """Read a pack without modifying it and validate every framed record."""
    result = {
        "name": name,
        "size": 0,
        "records": [],
        "truncated": False,
        "framing_error": None,
    }
    try:
        file_size = os.path.getsize(path)
    except OSError as exc:
        result["framing_error"] = f"cannot stat pack ({exc.__class__.__name__})"
        return result
    result["size"] = file_size

    offset = 0
    try:
        with open(path, "rb") as handle:
            while offset < file_size:
                if file_size - offset < PACK_HEADER.size:
                    result["truncated"] = True
                    break
                handle.seek(offset)
                header = handle.read(PACK_HEADER.size)
                if len(header) != PACK_HEADER.size:
                    result["truncated"] = True
                    break
                magic, sha_raw, raw_len, stored_len, expected_crc = PACK_HEADER.unpack(header)
                if magic != PACK_MAGIC:
                    result["framing_error"] = f"bad magic at offset {offset}"
                    break
                if (
                    raw_len > MAX_CHUNK_SIZE
                    or stored_len < 1
                    or stored_len > MAX_STORED_SIZE
                ):
                    result["framing_error"] = f"invalid record length at offset {offset}"
                    break
                end = offset + PACK_HEADER.size + stored_len
                if end > file_size:
                    result["truncated"] = True
                    break
                payload = handle.read(stored_len)
                if len(payload) != stored_len:
                    result["truncated"] = True
                    break

                sha = sha_raw.hex()
                record = {
                    "sha256": sha,
                    "pack": name,
                    "offset": offset + PACK_HEADER.size,
                    "raw_len": raw_len,
                    "stored_len": stored_len,
                    "crc32": expected_crc,
                    "crc_ok": False,
                    "sha_ok": False,
                    "reason": None,
                }
                if (zlib.crc32(payload) & 0xFFFFFFFF) != expected_crc:
                    record["reason"] = "crc32"
                    result["records"].append(record)
                    offset = end
                    continue
                record["crc_ok"] = True
                try:
                    raw = decompress_chunk(payload, record["raw_len"])
                except zlib.error:
                    record["reason"] = "zlib"
                else:
                    if len(raw) != raw_len:
                        record["reason"] = "length"
                    elif sha256_hex(raw) != sha:
                        record["reason"] = "sha256"
                    else:
                        record["sha_ok"] = True
                result["records"].append(record)
                offset = end
    except OSError as exc:
        result["framing_error"] = f"cannot read pack ({exc.__class__.__name__})"
    return result


class ReadOnlyIndex:
    def __init__(self, path):
        self.path = path
        self.error = None
        self._conn = None
        self._tmpdir = None
        if not os.path.exists(path):
            self.error = "index.sqlite3 is missing"
            return

        # Copy the index to a temporary directory so SQLite never creates
        # -shm/-wal files inside the real data directory during verification.
        try:
            self._tmpdir = tempfile.mkdtemp(prefix="obk-verify-")
            target = os.path.join(self._tmpdir, "index.sqlite3")
            shutil.copyfile(path, target)
            for suffix in ("-wal", "-journal"):
                sidecar = path + suffix
                if os.path.exists(sidecar):
                    shutil.copyfile(sidecar, target + suffix)
        except OSError as exc:
            self.error = (
                "cannot copy index for read-only verification "
                f"({exc.__class__.__name__})"
            )
            self._cleanup()
            return

        conn = None
        try:
            # The copy is opened read-write so SQLite can replay a copied WAL
            # and create its own -shm in the temporary directory. The real
            # data directory remains untouched.
            conn = sqlite3.connect(
                target,
                timeout=30,
                check_same_thread=False,
            )
            conn.execute("SELECT COUNT(*) FROM chunks").fetchone()
            self._conn = conn
            return
        except sqlite3.Error as exc:
            if conn is not None:
                conn.close()
            self.error = str(exc)
            self._cleanup()

    def _cleanup(self):
        if self._tmpdir is not None:
            shutil.rmtree(self._tmpdir, ignore_errors=True)
            self._tmpdir = None

    def close(self):
        if self._conn is not None:
            self._conn.close()
            self._conn = None
        self._cleanup()

    def all_chunk_records(self, user):
        if self._conn is None:
            return []
        rows = self._conn.execute(
            "SELECT sha256, pack, offset, raw_len, stored_len, crc32 "
            "FROM chunks WHERE username=?",
            (user,),
        ).fetchall()
        return [
            {
                "sha256": row[0],
                "pack": row[1],
                "offset": row[2],
                "raw_len": row[3],
                "stored_len": row[4],
                "crc32": row[5],
            }
            for row in rows
        ]


def _verify_user(data_dir, user, index, verbose=False):
    user_dir = os.path.join(data_dir, "users", user)
    packs_dir = os.path.join(user_dir, "packs")
    snapshots_dir = os.path.join(user_dir, "snapshots")

    report = {
        "packs": [],
        "index_error": index.error,
        "index_records": 0,
        "healthy_records": 0,
        "healthy_indexed_chunks": 0,
        "corrupt_chunks": [],
        "missing_index": [],
        "missing_pack_records": [],
        "index_mismatches": [],
        "duplicate_pack_records": [],
        "orphan_records": [],
        "unreferenced_chunks": [],
        "missing_chunks": [],
        "snapshot_errors": [],
        "truncated_packs": [],
        "framing_errors": [],
    }

    index_records = {}
    if index.error is None:
        try:
            index_records = {
                record["sha256"]: record for record in index.all_chunk_records(user)
            }
        except sqlite3.Error as exc:
            report["index_error"] = str(exc)
            index.error = report["index_error"]
    report["index_records"] = len(index_records)

    locations = {}
    pack_files = []
    if os.path.isdir(packs_dir):
        for name in sorted(os.listdir(packs_dir)):
            if not PACK_FILE_RE.match(name):
                continue
            path = os.path.join(packs_dir, name)
            if not os.path.isfile(path):
                continue
            pack_files.append((name, path))
    for name, path in pack_files:
        if verbose:
            sys.stderr.write(f"[verify] user={user} pack={name}\n")
        scanned = verify_pack_file(path, name)
        report["packs"].append(
            {
                "name": name,
                "size": scanned["size"],
                "records": len(scanned["records"]),
            }
        )
        if scanned["truncated"]:
            report["truncated_packs"].append(
                {"pack": name, "size": scanned["size"]}
            )
        if scanned["framing_error"]:
            report["framing_errors"].append(
                {"pack": name, "error": scanned["framing_error"]}
            )
        for record in scanned["records"]:
            locations.setdefault(record["sha256"], []).append(record)
            if record["crc_ok"] and record["sha_ok"]:
                report["healthy_records"] += 1

    healthy_indexed = set()
    for sha, records in locations.items():
        indexed = index_records.get(sha)
        if indexed is None:
            for record in records:
                entry = {
                    "sha256": sha,
                    "pack": record["pack"],
                    "offset": record["offset"],
                    "reason": record["reason"],
                }
                report["missing_index"].append(entry)
                report["orphan_records"].append(
                    {"kind": "not_indexed", **entry}
                )
                if not (record["crc_ok"] and record["sha_ok"]):
                    report["corrupt_chunks"].append(
                        {
                            "sha256": sha,
                            "pack": record["pack"],
                            "offset": record["offset"],
                            "reason": record["reason"] or "unknown",
                            "indexed": False,
                        }
                    )
            continue

        matching = [
            record
            for record in records
            if record["pack"] == indexed["pack"]
            and record["offset"] == indexed["offset"]
        ]
        matched = matching[0] if matching else None
        metadata_ok = bool(matched) and (
            matched["raw_len"] == indexed["raw_len"]
            and matched["stored_len"] == indexed["stored_len"]
            and matched["crc32"] == indexed["crc32"]
        )
        if matched is not None and not metadata_ok:
            report["index_mismatches"].append(
                {
                    "sha256": sha,
                    "pack": indexed["pack"],
                    "offset": indexed["offset"],
                    "reason": "metadata",
                }
            )
        for record in records:
            is_indexed = matched is not None and record is matched
            if record["crc_ok"] and record["sha_ok"]:
                if is_indexed and metadata_ok:
                    healthy_indexed.add(sha)
                    report["healthy_indexed_chunks"] += 1
            else:
                report["corrupt_chunks"].append(
                    {
                        "sha256": sha,
                        "pack": record["pack"],
                        "offset": record["offset"],
                        "reason": record["reason"] or "unknown",
                        "indexed": is_indexed,
                    }
                )
            if not is_indexed:
                entry = {
                    "sha256": sha,
                    "pack": record["pack"],
                    "offset": record["offset"],
                }
                report["duplicate_pack_records"].append(entry)
                report["orphan_records"].append({"kind": "duplicate", **entry})

        if not matching:
            if records:
                report["index_mismatches"].append(
                    {
                        "sha256": sha,
                        "pack": indexed["pack"],
                        "offset": indexed["offset"],
                        "reason": "location",
                    }
                )
            else:
                report["missing_pack_records"].append(
                    {
                        "sha256": sha,
                        "pack": indexed["pack"],
                        "offset": indexed["offset"],
                    }
                )

    for sha, indexed in index_records.items():
        if sha not in locations:
            report["missing_pack_records"].append(
                {
                    "sha256": sha,
                    "pack": indexed["pack"],
                    "offset": indexed["offset"],
                }
            )

    referenced = set()
    if os.path.isdir(snapshots_dir):
        for filename in sorted(os.listdir(snapshots_dir)):
            if not filename.endswith(".json"):
                continue
            snapshot_id = filename[:-5]
            path = os.path.join(snapshots_dir, filename)
            try:
                raw_manifest = _verify_read_manifest(path)
                manifest = normalize_manifest(raw_manifest)
                if manifest["id"] != snapshot_id:
                    raise ApiError(
                        500,
                        "snapshot_corrupt",
                        "manifest id does not match its filename",
                    )
            except ApiError as exc:
                report["snapshot_errors"].append(
                    {"snapshot": snapshot_id, "error": exc.message}
                )
                continue
            raw_files = manifest.get("files")
            if not isinstance(raw_files, list):
                report["snapshot_errors"].append(
                    {"snapshot": snapshot_id, "error": "files is not a list"}
                )
                continue
            for item in raw_files:
                if not isinstance(item, dict):
                    continue
                chunks = item.get("chunks")
                if not isinstance(chunks, list):
                    continue
                for chunk in chunks:
                    if not isinstance(chunk, str) or not SHA_RE.match(chunk):
                        continue
                    sha = chunk.lower()
                    referenced.add(sha)
                    if sha not in healthy_indexed:
                        report["missing_chunks"].append(
                            {"snapshot": snapshot_id, "sha256": sha}
                        )

    for sha, indexed in index_records.items():
        if sha not in referenced:
            report["unreferenced_chunks"].append(
                {
                    "sha256": sha,
                    "pack": indexed["pack"],
                    "offset": indexed["offset"],
                }
            )

    failures = (
        report["corrupt_chunks"]
        or report["missing_index"]
        or report["missing_pack_records"]
        or report["index_mismatches"]
        or report["missing_chunks"]
        or report["snapshot_errors"]
        or report["truncated_packs"]
        or report["framing_errors"]
        or report["index_error"]
    )
    report["ok"] = not failures
    return report


def verify_data_dir(data_dir, user=None, quarantine=False, verbose=False):
    data_dir = os.path.abspath(data_dir)
    users_store = UserStore(data_dir, verbose=False)
    known_users = users_store.list_names()

    if user is not None:
        user = validate_username(user)
        if user not in known_users:
            raise ApiError(404, "user_not_found", f"user {user} does not exist")
        selected = [user]
    else:
        selected = sorted(set(known_users) | set(_verify_user_dirs(data_dir)))

    index = ReadOnlyIndex(os.path.join(data_dir, "index.sqlite3"))
    report = {
        "ok": True,
        "data_dir": data_dir,
        "index_error": index.error,
        "users": {},
        "quarantine": {},
    }
    if index.error:
        report["ok"] = False

    try:
        for name in selected:
            user_report = _verify_user(data_dir, name, index, verbose=verbose)
            report["users"][name] = user_report
            if user_report.get("index_error") and not report["index_error"]:
                report["index_error"] = user_report["index_error"]
            if not user_report["ok"]:
                report["ok"] = False
    finally:
        index.close()

    if quarantine:
        if report["index_error"]:
            raise ApiError(
                500,
                "index_unreadable",
                "cannot quarantine because the index is unreadable",
            )
        removals = {}
        for name, user_report in report["users"].items():
            shas = set()
            for entry in user_report["corrupt_chunks"]:
                if entry.get("indexed"):
                    shas.add(entry["sha256"])
            for entry in user_report["missing_pack_records"]:
                shas.add(entry["sha256"])
            for entry in user_report["index_mismatches"]:
                shas.add(entry["sha256"])
            if shas:
                removals[name] = shas
        report["quarantine"] = _quarantine_chunks(
            os.path.join(data_dir, "index.sqlite3"), removals
        )

    return report


def _quarantine_chunks(db_path, removals):
    if not removals:
        return {}
    if not os.path.exists(db_path):
        raise ApiError(500, "index_unreadable", "cannot quarantine without an index")
    quoted = quote(os.path.abspath(db_path).replace("\\", "/"), safe="/:")
    conn = None
    removed = {}
    try:
        conn = sqlite3.connect(
            f"file:{quoted}?mode=rw",
            uri=True,
            timeout=30,
            isolation_level=None,
        )
        conn.execute("PRAGMA busy_timeout=30000")
        conn.execute("BEGIN IMMEDIATE")
        for user, shas in removals.items():
            ordered = sorted(shas)
            conn.executemany(
                "DELETE FROM chunks WHERE username=? AND sha256=?",
                [(user, sha) for sha in ordered],
            )
            removed[user] = len(ordered)
        conn.execute("COMMIT")
    except sqlite3.Error as exc:
        if conn is not None:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
        raise ApiError(
            500,
            "quarantine_failed",
            f"cannot update index during quarantine ({exc.__class__.__name__})",
        )
    finally:
        if conn is not None:
            conn.close()
    return removed


def _print_verify_human(report):
    if report.get("index_error"):
        print(f"index error: {report['index_error']}")
    for user, data in report["users"].items():
        print(
            f"user {user}: {len(data['packs'])} pack(s), "
            f"{data['healthy_records']} healthy record(s), "
            f"{len(data['corrupt_chunks'])} corrupt chunk(s), "
            f"{len(data['missing_index'])} missing index entry(ies), "
            f"{len(data['missing_pack_records'])} missing pack record(s)"
        )
        for entry in data["corrupt_chunks"]:
            print(
                f"  CORRUPT {entry['sha256']} pack={entry['pack']} "
                f"offset={entry['offset']} reason={entry['reason']} "
                f"indexed={str(entry['indexed']).lower()}"
            )
        for entry in data["missing_index"]:
            print(
                f"  MISSING_INDEX {entry['sha256']} pack={entry['pack']} "
                f"offset={entry['offset']} reason={entry['reason'] or 'unknown'}"
            )
        for entry in data["missing_pack_records"]:
            print(
                f"  MISSING_PACK_RECORD {entry['sha256']} "
                f"pack={entry['pack']} offset={entry['offset']}"
            )
        for entry in data["index_mismatches"]:
            print(
                f"  INDEX_MISMATCH {entry['sha256']} "
                f"pack={entry['pack']} offset={entry['offset']} "
                f"reason={entry.get('reason', 'unknown')}"
            )
        for entry in data["missing_chunks"]:
            print(
                f"  MISSING_CHUNK snapshot={entry['snapshot']} "
                f"sha256={entry['sha256']}"
            )
        for entry in data["snapshot_errors"]:
            print(
                f"  BAD_SNAPSHOT {entry['snapshot']}: {entry['error']}"
            )
        for entry in data["truncated_packs"]:
            print(
                f"  TRUNCATED_PACK {entry['pack']} size={entry['size']}"
            )
        for entry in data["framing_errors"]:
            print(f"  PACK_ERROR {entry['pack']}: {entry['error']}")
        for entry in data["unreferenced_chunks"]:
            print(
                f"  WARN_UNREFERENCED {entry['sha256']} "
                f"pack={entry['pack']} offset={entry['offset']}"
            )
        for entry in data["duplicate_pack_records"]:
            print(
                f"  WARN_DUPLICATE {entry['sha256']} "
                f"pack={entry['pack']} offset={entry['offset']}"
            )
    if report.get("quarantine"):
        for user, count in report["quarantine"].items():
            print(f"quarantined {count} index entry(ies) for user {user}")
    print("overall:", "OK" if report["ok"] else "FAILED")


# ---------------------------------------------------------------------------
# Admin HTML
# ---------------------------------------------------------------------------

ADMIN_STYLE = """
:root {
  color-scheme: light dark;
  --bg: #101418;
  --card: #171d24;
  --line: #2a333d;
  --text: #e6edf3;
  --muted: #98a4b3;
  --accent: #4f9cf9;
  --danger: #e5534b;
  --ok: #3fb950;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f6f8fa;
    --card: #ffffff;
    --line: #d8dee4;
    --text: #1f2328;
    --muted: #59636e;
    --accent: #0969da;
    --danger: #cf222e;
    --ok: #1a7f37;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 2rem 1rem 4rem;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 1180px; margin: 0 auto; }
h1 { font-size: 1.45rem; margin: 0 0 .25rem; }
h2 { font-size: 1.1rem; margin: 0 0 .75rem; }
p { margin: .35rem 0; }
a { color: var(--accent); }
code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  background: color-mix(in srgb, var(--card) 55%, var(--line));
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: .15rem .4rem;
  word-break: break-all;
}
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 1rem 1.15rem;
  margin-bottom: 1rem;
}
.topbar {
  display: flex;
  gap: 1rem;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}
.muted { color: var(--muted); }
.narrow { max-width: 420px; margin: 10vh auto 0; }
label { display: block; margin: .6rem 0; color: var(--muted); font-size: .92rem; }
input, select, button {
  font: inherit;
  border-radius: 8px;
  border: 1px solid var(--line);
  padding: .48rem .62rem;
  background: var(--bg);
  color: var(--text);
}
input[type=checkbox] { width: auto; margin-right: .35rem; }
button { cursor: pointer; background: var(--accent); border-color: var(--accent); color: #fff; }
button.secondary { background: transparent; color: var(--text); }
button.danger { background: var(--danger); border-color: var(--danger); }
button.small { padding: .28rem .5rem; font-size: .84rem; }
.row { display: flex; gap: .6rem; flex-wrap: wrap; align-items: end; }
.row > label, .row > div { margin: 0; }
.row input[name=user] { min-width: 200px; }
.form-inline { display: inline-flex; gap: .35rem; align-items: center; margin: 0 .25rem .35rem 0; flex-wrap: wrap; }
table { width: 100%; border-collapse: collapse; font-size: .92rem; }
th, td { border-bottom: 1px solid var(--line); padding: .6rem .45rem; text-align: left; vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
.flash { border: 1px solid var(--line); border-left-width: 4px; border-radius: 8px; padding: .65rem .8rem; margin-bottom: 1rem; }
.flash.ok { border-left-color: var(--ok); }
.flash.error { border-left-color: var(--danger); }
.pill { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: .05rem .5rem; font-size: .8rem; margin: .1rem .15rem .1rem 0; }
.badge-danger { color: var(--danger); border-color: var(--danger); }
.actions { min-width: 320px; }
@media (max-width: 780px) {
  table, thead, tbody, tr, th, td { display: block; }
  thead { display: none; }
  tr { border-bottom: 1px solid var(--line); padding: .5rem 0; }
  td { border: 0; padding: .25rem .1rem; }
}
"""


def esc(value):
    return html.escape("" if value is None else str(value), quote=True)


def human_bytes(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "0 B"
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if number < 1024 or unit == "TiB":
            if unit == "B":
                return f"{number:.0f} {unit}"
            return f"{number:.1f} {unit}"
        number /= 1024
    return f"{number:.1f} TiB"


def admin_page(title, body):
    return (
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{esc(title)} · OpenCode Backup</title><style>{ADMIN_STYLE}</style>"
        f"</head><body><main>{body}</main></body></html>"
    )


def render_login_page(csrf, error=None):
    error_html = ""
    if error:
        error_html = f'<div class="flash error">{esc(error)}</div>'
    body = f"""
<section class="card narrow">
  <h1>OpenCode Backup</h1>
  <p class="muted">管理员登录</p>
  {error_html}
  <form method="post" action="/admin/login" autocomplete="on">
    <input type="hidden" name="_csrf" value="{esc(csrf)}">
    <label>管理员密码
      <input type="password" name="password" required autofocus
             autocomplete="current-password" style="width:100%">
    </label>
    <button type="submit" style="width:100%">登录</button>
  </form>
  <p class="muted" style="margin-top:1rem">
    登录后可以添加、禁用或删除备份用户，并查看用量。
  </p>
</section>
"""
    return admin_page("管理员登录", body)


def render_admin_error(status, message):
    body = f"""
<section class="card narrow">
  <h1>{status} · 请求失败</h1>
  <p>{esc(message)}</p>
  <p><a href="/admin">返回管理后台</a></p>
</section>
"""
    return admin_page("请求失败", body)


def render_dashboard(users, csrf, flash):
    parts = []
    parts.append(
        f"""
<header class="topbar">
  <div>
    <h1>OpenCode Backup 管理后台</h1>
    <p class="muted">用户隔离 · 追加写 pack · 仅管理员可创建用户</p>
  </div>
  <form method="post" action="/admin/logout">
    <input type="hidden" name="_csrf" value="{esc(csrf)}">
    <button type="submit" class="secondary">退出登录</button>
  </form>
</header>
"""
    )

    if flash:
        kind = "ok" if flash.get("kind") == "ok" else "error"
        if flash.get("token"):
            parts.append(
                f'<div class="flash {kind}">'
                f"用户 <strong>{esc(flash.get('token_user'))}</strong> 的 token "
                f"(只显示一次): <code id=\"new-token\">{esc(flash['token'])}</code>"
                "</div>"
            )
        elif flash.get("message"):
            parts.append(
                f'<div class="flash {kind}">{esc(flash["message"])}</div>'
            )

    parts.append(
        f"""
<section class="card">
  <h2>添加用户</h2>
  <form method="post" action="/admin/users" class="row">
    <input type="hidden" name="_csrf" value="{esc(csrf)}">
    <label>用户名
      <input name="user" required maxlength="64" pattern="[A-Za-z0-9._-]{{1,64}}"
             placeholder="alice" autocomplete="off">
    </label>
    <label>认证方式
      <select name="mode">
        <option value="token">生成 Token</option>
        <option value="password">设置密码</option>
      </select>
    </label>
    <label>初始密码（选择“设置密码”时）
      <input type="password" name="password" minlength="1" maxlength="1024"
             autocomplete="new-password" placeholder="留空则忽略">
    </label>
    <button type="submit">添加用户</button>
  </form>
  <p class="muted">Token 只在创建或重新生成时显示一次。用户必须保持启用状态才能上传或下载。</p>
</section>
"""
    )

    rows = []
    for info in users:
        user = info["user"]
        quser = quote(user, safe="")
        methods = []
        if info.get("has_password"):
            methods.append("密码")
        if info.get("has_token"):
            methods.append("Token")
        if not methods:
            methods.append("无凭据")
        status_label = "已禁用" if info.get("disabled") else "启用"
        status_class = "badge-danger" if info.get("disabled") else ""
        usage = info.get("usage") or {}
        usage_note = ""
        if info.get("usage_error"):
            usage_note = (
                f'<br><span class="muted">用量读取失败: {esc(info["usage_error"])}</span>'
            )
        toggle_action = "enable" if info.get("disabled") else "disable"
        toggle_label = "启用" if info.get("disabled") else "禁用"

        actions = f"""
<div class="actions">
  <form method="post" action="/admin/users/{quser}/token" class="form-inline">
    <input type="hidden" name="_csrf" value="{esc(csrf)}">
    <button type="submit" class="secondary small">生成 Token</button>
  </form>
  <form method="post" action="/admin/users/{quser}/password" class="form-inline">
    <input type="hidden" name="_csrf" value="{esc(csrf)}">
    <input type="password" name="password" required maxlength="1024"
           placeholder="新密码" autocomplete="new-password">
    <button type="submit" class="secondary small">设置密码</button>
  </form>
  <form method="post" action="/admin/users/{quser}/{toggle_action}" class="form-inline">
    <input type="hidden" name="_csrf" value="{esc(csrf)}">
    <button type="submit" class="secondary small">{toggle_label}</button>
  </form>
  <form method="post" action="/admin/users/{quser}/delete" class="form-inline">
    <input type="hidden" name="_csrf" value="{esc(csrf)}">
    <label style="margin:0;color:var(--muted)">
      <input type="checkbox" name="confirm" value="{esc(user)}" required>确认
    </label>
    <button type="submit" class="danger small">删除全部数据</button>
  </form>
</div>
"""

        rows.append(
            f"""
<tr>
  <td><strong>{esc(user)}</strong><br><span class="muted">{esc(info.get("created_at"))}</span></td>
  <td><span class="pill {status_class}">{status_label}</span></td>
  <td>{" / ".join(esc(item) for item in methods)}</td>
  <td>
    快照 {usage.get("snapshots", 0)} / {human_bytes(usage.get("snapshot_bytes", 0))}<br>
    Chunk {usage.get("chunks", 0)} / {human_bytes(usage.get("stored_bytes", 0))}<br>
    <span class="muted">pack {human_bytes(usage.get("pack_bytes", 0))}</span>{usage_note}
  </td>
  <td>{actions}</td>
</tr>
"""
        )

    if not rows:
        rows.append('<tr><td colspan="5" class="muted">还没有用户。</td></tr>')

    parts.append(
        f"""
<section class="card">
  <h2>用户与用量</h2>
  <table>
    <thead>
      <tr><th>用户</th><th>状态</th><th>凭据</th><th>用量</th><th>操作</th></tr>
    </thead>
    <tbody>
      {''.join(rows)}
    </tbody>
  </table>
  <p class="muted">
    删除用户会同时删除该用户的快照、chunk 与 pack 文件，且不可恢复。
    密码和 token 只保存 scrypt 哈希，服务端不会记录明文。
  </p>
</section>
"""
    )
    return admin_page("管理后台", "".join(parts))


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------


class BackupHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, server_address, store, verbose=False):
        self.store = store
        self.verbose = verbose
        super().__init__(server_address, BackupRequestHandler)

    def handle_error(self, request, client_address):
        if self.verbose:
            super().handle_error(request, client_address)


class BackupRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "OpenCodeBackup/" + VERSION
    sys_version = ""

    # -- logging ---------------------------------------------------------

    def log_message(self, fmt, *args):
        if getattr(self.server, "verbose", False):
            sys.stderr.write(
                f"[{now_iso()}] {self.client_address[0]} {fmt % args}\n"
            )
            sys.stderr.flush()

    def log_error(self, fmt, *args):
        if getattr(self.server, "verbose", False):
            self.log_message(fmt, *args)

    # -- dispatch --------------------------------------------------------

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("HEAD")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_POST(self):
        self._dispatch("POST")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method):
        admin_request = False
        try:
            parts = parse_request_path(self.path)
            admin_request = bool(parts and parts[0] == "admin")

            if parts == ["v1", "health"]:
                if method != "GET":
                    raise ApiError(405, "method_not_allowed", "health only supports GET")
                self._send_json(200, {"ok": True, "version": VERSION})
                return

            if admin_request:
                self._dispatch_admin(method, parts)
                return

            route = self._resolve_route(parts)
            if route is None:
                raise ApiError(404, "not_found", "endpoint does not exist")
            self._authenticate(route["user"])
            self._dispatch_api(method, route)
        except ApiError as exc:
            self.close_connection = True
            if admin_request:
                self._send_admin_error(exc.status, exc.message)
            else:
                self._send_json(
                    exc.status,
                    {"error": {"code": exc.code, "message": exc.message}},
                    extra_headers=exc.headers,
                )
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception:
            self.close_connection = True
            if getattr(self.server, "verbose", False):
                traceback.print_exc()
            if admin_request:
                self._send_admin_error(500, "internal server error")
            else:
                self._send_json(
                    500,
                    {"error": {"code": "internal_error", "message": "internal server error"}},
                )

    def _resolve_route(self, parts):
        if (
            len(parts) == 5
            and parts[0] == "v1"
            and parts[1] == "users"
            and parts[3] == "chunks"
        ):
            return {
                "kind": "chunk",
                "user": validate_username(parts[2]),
                "sha256": normalize_sha(parts[4]),
            }
        if (
            len(parts) == 4
            and parts[0] == "v1"
            and parts[1] == "users"
            and parts[3] == "snapshots"
        ):
            return {"kind": "snapshots", "user": validate_username(parts[2])}
        if (
            len(parts) == 5
            and parts[0] == "v1"
            and parts[1] == "users"
            and parts[3] == "snapshots"
        ):
            return {
                "kind": "snapshot",
                "user": validate_username(parts[2]),
                "snapshot_id": validate_snapshot_id(parts[4]),
            }
        return None

    def _authenticate(self, user):
        credentials = parse_authorization(self.headers.get("Authorization"))
        if credentials is None:
            raise ApiError(
                401,
                "unauthorized",
                "missing or malformed credentials",
                headers={
                    "WWW-Authenticate": (
                        'Bearer realm="opencode-backup", '
                        'Basic realm="opencode-backup"'
                    )
                },
            )
        scheme, secret = credentials
        if scheme == "bearer":
            ok = self.server.store.users.verify_token(user, secret)
        else:
            username, password = secret
            ok = username == user and self.server.store.users.verify_password(
                user, password
            )
        if not ok:
            raise ApiError(
                401,
                "unauthorized",
                "invalid credentials or disabled user",
                headers={"WWW-Authenticate": 'Bearer realm="opencode-backup"'},
            )

    def _dispatch_api(self, method, route):
        if route["kind"] == "chunk":
            if method == "PUT":
                self._handle_put_chunk(route["user"], route["sha256"])
                return
            if method == "GET":
                self._handle_get_chunk(route["user"], route["sha256"])
                return
            if method == "HEAD":
                self._handle_head_chunk(route["user"], route["sha256"])
                return
            raise ApiError(
                405,
                "method_not_allowed",
                "chunks support GET, PUT and HEAD",
                headers={"Allow": "GET, PUT, HEAD"},
            )

        if route["kind"] == "snapshots":
            if method == "POST":
                self._handle_create_snapshot(route["user"])
                return
            if method == "GET":
                snapshots = self.server.store.list_snapshots(route["user"])
                self._send_json(200, {"snapshots": snapshots})
                return
            raise ApiError(
                405,
                "method_not_allowed",
                "snapshots support GET and POST",
                headers={"Allow": "GET, POST"},
            )

        if route["kind"] == "snapshot":
            if method == "GET":
                manifest = self.server.store.get_snapshot(
                    route["user"], route["snapshot_id"]
                )
                self._send_json(200, manifest)
                return
            if method == "DELETE":
                self.server.store.delete_snapshot(
                    route["user"], route["snapshot_id"]
                )
                self._send_empty(204)
                return
            raise ApiError(
                405,
                "method_not_allowed",
                "snapshot supports GET and DELETE",
                headers={"Allow": "GET, DELETE"},
            )

        raise ApiError(404, "not_found", "endpoint does not exist")

    # -- API handlers ----------------------------------------------------

    def _handle_put_chunk(self, user, sha):
        raw = self._read_body(MAX_CHUNK_SIZE)
        if sha256_hex(raw) != sha:
            raise ApiError(400, "sha256_mismatch", "chunk body does not match the path SHA-256")
        created = self.server.store.put_chunk(user, raw, sha)
        if created:
            self._send_empty(201)
        else:
            self._send_empty(204)

    def _handle_get_chunk(self, user, sha):
        raw = self.server.store.get_chunk(user, sha)
        self._send_bytes(200, raw, "application/octet-stream")

    def _handle_head_chunk(self, user, sha):
        if self.server.store.chunk_exists(user, sha):
            self._send_empty(200)
            return
        raise ApiError(404, "chunk_not_found", f"chunk {sha} is not stored")

    def _handle_create_snapshot(self, user):
        body = self._read_body(MAX_MANIFEST_SIZE)
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(400, "invalid_json", "snapshot body must be UTF-8 JSON")
        manifest = self.server.store.create_snapshot(user, payload)
        self._send_json(201, {"id": manifest["id"]})

    # -- admin dispatch --------------------------------------------------

    def _dispatch_admin(self, method, parts):
        if parts == ["admin"]:
            if method != "GET":
                raise ApiError(405, "method_not_allowed", "admin page only supports GET")
            self._admin_index()
            return
        if parts == ["admin", "login"]:
            if method == "GET":
                self._redirect("/admin")
                return
            if method != "POST":
                raise ApiError(405, "method_not_allowed", "login only supports POST")
            self._admin_login()
            return
        if parts == ["admin", "logout"]:
            if method != "POST":
                raise ApiError(405, "method_not_allowed", "logout only supports POST")
            self._admin_logout()
            return
        if len(parts) == 2 and parts[0] == "admin" and parts[1] == "users":
            if method != "POST":
                raise ApiError(405, "method_not_allowed", "user creation only supports POST")
            self._admin_create_user()
            return
        if (
            len(parts) == 4
            and parts[0] == "admin"
            and parts[1] == "users"
            and parts[3] in ("disable", "enable", "token", "password", "delete")
        ):
            if method != "POST":
                raise ApiError(405, "method_not_allowed", "user actions only support POST")
            self._admin_user_action(
                validate_username(parts[2]),
                parts[3],
            )
            return
        raise ApiError(404, "not_found", "admin page does not exist")

    def _admin_cookie_sid(self):
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        try:
            cookies = SimpleCookie()
            cookies.load(raw)
        except CookieError:
            return None
        morsel = cookies.get(ADMIN_SESSION_COOKIE)
        return morsel.value if morsel is not None else None

    @staticmethod
    def _admin_cookie(sid):
        return (
            f"{ADMIN_SESSION_COOKIE}={sid}; Path=/admin; HttpOnly; "
            f"SameSite=Lax; Max-Age={ADMIN_SESSION_TTL}"
        )

    @staticmethod
    def _admin_clear_cookie():
        return (
            f"{ADMIN_SESSION_COOKIE}=; Path=/admin; HttpOnly; "
            "SameSite=Lax; Max-Age=0"
        )

    def _admin_session(self, require_auth=False):
        sid = self._admin_cookie_sid()
        session = None
        if sid:
            session = self.server.store.admin_auth.get_session(sid)
        if require_auth and (not session or not session.get("authenticated")):
            return None, sid
        return session, sid

    def _admin_index(self):
        session, sid = self._admin_session()
        admin = self.server.store.admin_auth
        if session and session.get("authenticated"):
            self._admin_dashboard(sid, session)
            return
        if session is None:
            sid, csrf = admin.create_pending_session()
            set_cookie = self._admin_cookie(sid)
        else:
            csrf = session["csrf"]
            set_cookie = None
        self._send_admin_html(
            200,
            render_login_page(csrf),
            set_cookie=set_cookie,
        )

    def _admin_dashboard(self, sid, session):
        store = self.server.store
        flash = store.admin_auth.pop_flash(sid)
        users = []
        for info in store.users.list_users():
            try:
                info["usage"] = store.user_usage(info["user"])
            except ApiError as exc:
                info["usage"] = {}
                info["usage_error"] = exc.message
            users.append(info)
        self._send_admin_html(
            200,
            render_dashboard(users, session["csrf"], flash),
        )

    def _admin_login(self):
        form = self._read_form()
        session, sid = self._admin_session()
        if session is None:
            raise ApiError(403, "csrf_failed", "登录会话已过期，请刷新页面后重试")
        supplied = form.get("_csrf", "")
        if not isinstance(supplied, str) or not hmac.compare_digest(
            session["csrf"], supplied
        ):
            raise ApiError(403, "csrf_failed", "CSRF token 无效")
        if session.get("authenticated"):
            self._redirect("/admin")
            return

        admin = self.server.store.admin_auth
        client_ip = self.client_address[0]
        retry_after = admin.rate_limited(client_ip)
        if retry_after:
            self._send_admin_html(
                429,
                render_login_page(session["csrf"], "尝试次数过多，请稍后再试。"),
                extra_headers={"Retry-After": str(retry_after)},
            )
            return

        password = form.get("password", "")
        if admin.verify_password(password):
            admin.clear_failures(client_ip)
            new_sid, _csrf = admin.rotate_authenticated(sid)
            admin.set_flash(
                new_sid,
                {"kind": "ok", "message": "登录成功。"},
            )
            self._redirect("/admin", set_cookie=self._admin_cookie(new_sid))
            return

        admin.record_failure(client_ip)
        self._send_admin_html(
            401,
            render_login_page(session["csrf"], "密码错误。"),
        )

    def _admin_logout(self):
        form = self._read_form()
        sid, _session = self._admin_require_post(form)
        self.server.store.admin_auth.destroy(sid)
        self._redirect("/admin", set_cookie=self._admin_clear_cookie())

    def _admin_require_post(self, form):
        session, sid = self._admin_session(require_auth=True)
        if not session:
            raise ApiError(403, "admin_forbidden", "请先登录管理员后台")
        supplied = form.get("_csrf", "")
        if not isinstance(supplied, str) or not hmac.compare_digest(
            session["csrf"], supplied
        ):
            raise ApiError(403, "csrf_failed", "CSRF token 无效")
        return sid, session

    def _admin_create_user(self):
        form = self._read_form()
        sid, _session = self._admin_require_post(form)
        admin = self.server.store.admin_auth
        users = self.server.store.users
        user = form.get("user", "")
        mode = form.get("mode", "token")
        try:
            if mode == "token":
                token = users.add_user(user, generate_token=True)
                flash = {
                    "kind": "ok",
                    "message": f"已创建用户 {user}。",
                    "token": token,
                    "token_user": user,
                }
            elif mode == "password":
                users.add_user(user, password=form.get("password", ""))
                flash = {
                    "kind": "ok",
                    "message": f"已创建用户 {user}，可以使用密码认证。",
                }
            else:
                raise ApiError(400, "invalid_mode", "认证方式无效")
        except ApiError as exc:
            flash = {"kind": "error", "message": exc.message}
        admin.set_flash(sid, flash)
        self._redirect("/admin")

    def _admin_user_action(self, user, action):
        form = self._read_form()
        sid, _session = self._admin_require_post(form)
        admin = self.server.store.admin_auth
        store = self.server.store
        users = store.users
        try:
            if action == "disable":
                users.set_disabled(user, True)
                flash = {"kind": "ok", "message": f"已禁用用户 {user}。"}
            elif action == "enable":
                users.set_disabled(user, False)
                flash = {"kind": "ok", "message": f"已启用用户 {user}。"}
            elif action == "token":
                token = users.issue_token(user)
                flash = {
                    "kind": "ok",
                    "message": f"已为 {user} 重新生成 token。",
                    "token": token,
                    "token_user": user,
                }
            elif action == "password":
                users.set_password(user, form.get("password", ""))
                flash = {"kind": "ok", "message": f"已更新 {user} 的密码。"}
            elif action == "delete":
                if form.get("confirm") != user:
                    raise ApiError(400, "confirmation_required", "请勾选确认后再删除用户")
                users.set_disabled(user, True)
                store.delete_user_data(user)
                users.delete_user(user)
                flash = {"kind": "ok", "message": f"已删除用户 {user} 及其全部数据。"}
            else:
                raise ApiError(404, "not_found", "未知的用户操作")
        except ApiError as exc:
            flash = {"kind": "error", "message": exc.message}
        admin.set_flash(sid, flash)
        self._redirect("/admin")

    # -- request body ----------------------------------------------------

    def _content_length(self, limit):
        if self.headers.get("Transfer-Encoding"):
            raise ApiError(400, "invalid_request", "Transfer-Encoding is not supported")
        values = self.headers.get_all("Content-Length") or []
        if not values:
            raise ApiError(411, "length_required", "Content-Length is required")
        if len(values) != 1:
            raise ApiError(400, "invalid_request", "multiple Content-Length headers")
        raw = values[0]
        try:
            length = int(raw)
        except ValueError:
            raise ApiError(400, "invalid_request", "Content-Length must be an integer")
        if length < 0:
            raise ApiError(400, "invalid_request", "Content-Length must be non-negative")
        if length > limit:
            raise ApiError(
                413,
                "payload_too_large",
                f"request body exceeds {limit} bytes",
            )
        return length

    def _read_body(self, limit):
        length = self._content_length(limit)
        if length == 0:
            return b""
        blocks = []
        remaining = length
        while remaining > 0:
            block = self.rfile.read(min(remaining, 1024 * 1024))
            if not block:
                raise ApiError(400, "incomplete_body", "request body ended early")
            blocks.append(block)
            remaining -= len(block)
        return b"".join(blocks)

    def _read_form(self):
        body = self._read_body(MAX_FORM_SIZE)
        try:
            parsed = parse_qs(body.decode("utf-8"), keep_blank_values=True)
        except UnicodeDecodeError:
            raise ApiError(400, "invalid_form", "form body must be UTF-8")
        return {key: values[0] for key, values in parsed.items() if values}

    # -- responses -------------------------------------------------------

    def _write_body(self, payload):
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _send_json(self, status, value, extra_headers=None):
        payload = json.dumps(
            value, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if self.close_connection:
            self.send_header("Connection", "close")
        for key, header_value in (extra_headers or {}).items():
            self.send_header(key, header_value)
        self.end_headers()
        self._write_body(payload)

    def _send_bytes(self, status, payload, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        self._write_body(payload)

    def _send_empty(self, status):
        self.send_response(status)
        if status != 204:
            self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()

    def _send_admin_html(self, status, body, set_cookie=None, extra_headers=None):
        payload = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", ADMIN_CSP)
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if set_cookie:
            self.send_header("Set-Cookie", set_cookie)
        if self.close_connection:
            self.send_header("Connection", "close")
        for key, header_value in (extra_headers or {}).items():
            self.send_header(key, header_value)
        self.end_headers()
        self._write_body(payload)

    def _send_admin_error(self, status, message):
        self._send_admin_html(status, render_admin_error(status, message))

    def _redirect(self, location, set_cookie=None):
        self.send_response(303)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        if set_cookie:
            self.send_header("Set-Cookie", set_cookie)
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()


# ---------------------------------------------------------------------------
# Public helpers and CLI
# ---------------------------------------------------------------------------


def init_data_dir(data_dir, admin_password=None, force_admin_password=False):
    data_dir = os.path.abspath(data_dir)
    os.makedirs(data_dir, exist_ok=True)
    users_dir = os.path.join(data_dir, "users")
    os.makedirs(users_dir, exist_ok=True)
    chmod_quiet(data_dir, 0o700)
    chmod_quiet(users_dir, 0o700)

    users_path = os.path.join(data_dir, "users.json")
    if not os.path.exists(users_path):
        atomic_write_json(users_path, {"version": 1, "users": {}}, mode=0o600)

    admin_path = os.path.join(data_dir, "admin.json")
    if admin_password is not None:
        if len(admin_password) < MIN_ADMIN_PASSWORD:
            raise ApiError(
                400,
                "weak_admin_password",
                f"admin password must be at least {MIN_ADMIN_PASSWORD} characters",
            )
        if os.path.exists(admin_path) and not force_admin_password:
            raise ApiError(
                400,
                "admin_exists",
                "admin.json already exists; use --force-admin-password to replace it",
            )
        atomic_write_json(
            admin_path,
            {
                "version": 1,
                "password_hash": make_secret_hash(admin_password),
                "created_at": now_iso(),
            },
            mode=0o600,
        )
    elif not os.path.exists(admin_path):
        raise ApiError(
            400,
            "admin_password_required",
            "admin password is required when creating a data directory",
        )

    db_path = os.path.join(data_dir, "index.sqlite3")
    try:
        db = Database(db_path)
        if not db.is_initialized():
            db.set_meta("schema_version", "1")
        db.close()
    except sqlite3.Error:
        try:
            os.replace(
                db_path,
                f"{db_path}.corrupt-"
                + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
            )
        except OSError:
            pass
        for extra in ("-wal", "-shm"):
            try:
                os.unlink(db_path + extra)
            except OSError:
                pass
        db = Database(db_path)
        db.set_meta("schema_version", "1")
        db.close()

    chmod_quiet(db_path, 0o600)
    return data_dir


def create_user(data_dir, user, password=None, token=None):
    store = UserStore(data_dir)
    return store.add_user(user, password=password, token=token)


def make_server(
    data_dir,
    host="127.0.0.1",
    port=0,
    verbose=False,
    start_flusher=True,
    auto_gc_keep=None,
):
    store = BackupStore(
        data_dir,
        verbose=verbose,
        start_flusher=start_flusher,
        auto_gc_keep=auto_gc_keep,
    )
    try:
        server = BackupHTTPServer((host, port), store, verbose=verbose)
    except BaseException:
        store.close()
        raise
    return server


def _prompt_admin_password():
    while True:
        first = getpass.getpass("Admin password: ")
        if len(first) < MIN_ADMIN_PASSWORD:
            print(
                f"Password must be at least {MIN_ADMIN_PASSWORD} characters.",
                file=sys.stderr,
            )
            continue
        second = getpass.getpass("Confirm admin password: ")
        if first != second:
            print("Passwords do not match.", file=sys.stderr)
            continue
        return first


def cmd_init(args):
    data_dir = os.path.abspath(args.data_dir)
    admin_path = os.path.join(data_dir, "admin.json")
    admin_exists = os.path.exists(admin_path)

    if admin_exists and args.admin_password is not None and not args.force_admin_password:
        raise ApiError(
            400,
            "admin_exists",
            "admin.json already exists; pass --force-admin-password to replace it",
        )

    password = args.admin_password
    need_password = not admin_exists or args.force_admin_password
    if need_password and password is None:
        password = _prompt_admin_password()
    if password is not None and len(password) < MIN_ADMIN_PASSWORD:
        raise ApiError(
            400,
            "weak_admin_password",
            f"admin password must be at least {MIN_ADMIN_PASSWORD} characters",
        )

    init_data_dir(
        data_dir,
        admin_password=password if need_password else None,
        force_admin_password=args.force_admin_password,
    )
    print(f"initialized data directory: {data_dir}")
    if admin_exists and not args.force_admin_password:
        print("admin password unchanged")
    print("start with: serve --data-dir PATH --host 127.0.0.1 --port 8787")


def cmd_adduser(args):
    store = UserStore(args.data_dir)
    if args.password is None and args.token is None:
        token = store.add_user(args.user)
        print(f"user added: {args.user}")
        print("auth: token")
        print(f"token: {token}")
        return
    token = store.add_user(
        args.user,
        password=args.password,
        token=args.token,
    )
    print(f"user added: {args.user}")
    methods = []
    if args.password is not None:
        methods.append("password")
    if args.token is not None:
        methods.append("token")
    print("auth: " + "+".join(methods))
    if token:
        print(f"token: {token}")


def cmd_list_users(args):
    store = UserStore(args.data_dir)
    users = store.list_users()
    if not users:
        print("no users")
        return
    print("USER\tSTATUS\tAUTH\tCREATED_AT")
    for info in users:
        methods = []
        if info["has_password"]:
            methods.append("password")
        if info["has_token"]:
            methods.append("token")
        print(
            f"{info['user']}\t"
            f"{'disabled' if info['disabled'] else 'enabled'}\t"
            f"{'+'.join(methods) or 'none'}\t"
            f"{info['created_at']}"
        )


def cmd_serve(args):
    data_dir = os.path.abspath(args.data_dir)
    if not os.path.exists(os.path.join(data_dir, "users.json")):
        raise ApiError(500, "not_initialized", "users.json not found; run init first")
    if not os.path.exists(os.path.join(data_dir, "admin.json")):
        raise ApiError(
            500,
            "admin_not_configured",
            "admin.json not found; run: init --data-dir PATH",
        )

    store = BackupStore(
        data_dir,
        verbose=args.verbose,
        auto_gc_keep=args.keep,
    )
    server = None
    try:
        server = BackupHTTPServer((args.host, args.port), store, verbose=args.verbose)
        actual_port = server.server_address[1]
        print(
            f"listening on http://{args.host}:{actual_port} "
            f"(admin: /admin, data: {data_dir})",
            flush=True,
        )
        if args.keep is not None and args.keep > 0:
            print(
                f"automatic GC: keep the latest {args.keep} snapshot(s) per user",
                flush=True,
            )
        try:
            server.serve_forever(poll_interval=0.5)
        except KeyboardInterrupt:
            print("stopping", flush=True)
    finally:
        if server is not None:
            server.server_close()
        store.close()


def cmd_gc(args):
    if args.keep < 0:
        raise ApiError(400, "invalid_arguments", "--keep must be non-negative")
    store = BackupStore(args.data_dir, verbose=args.verbose)
    try:
        stats = store.gc(args.keep, dry_run=args.dry_run)
    finally:
        store.close()
    print(json.dumps(stats, ensure_ascii=False, indent=2))


def cmd_verify(args):
    report = verify_data_dir(
        args.data_dir,
        user=args.user,
        quarantine=args.quarantine,
        verbose=args.verbose,
    )
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        _print_verify_human(report)
    return 0 if report["ok"] else 1


def build_parser():
    parser = argparse.ArgumentParser(
        prog="server.py",
        description="OpenCode chunked backup server (standard library only)",
    )
    parser.add_argument("--verbose", action="store_true", help="verbose logging")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init", help="initialize a data directory")
    init_parser.add_argument("--data-dir", required=True)
    init_parser.add_argument(
        "--admin-password",
        default=None,
        help="admin password; omit for an interactive prompt",
    )
    init_parser.add_argument(
        "--force-admin-password",
        action="store_true",
        help="replace an existing admin password",
    )
    init_parser.set_defaults(func=cmd_init)

    adduser_parser = subparsers.add_parser("adduser", help="add a backup user")
    adduser_parser.add_argument("--data-dir", required=True)
    adduser_parser.add_argument("--user", required=True)
    adduser_parser.add_argument(
        "--token",
        default=None,
        help="explicit token; omit to generate one when no password is given",
    )
    adduser_parser.add_argument(
        "--password",
        default=None,
        help="set a password for Basic authentication",
    )
    adduser_parser.set_defaults(func=cmd_adduser)

    list_parser = subparsers.add_parser("list-users", help="list backup users")
    list_parser.add_argument("--data-dir", required=True)
    list_parser.set_defaults(func=cmd_list_users)

    serve_parser = subparsers.add_parser("serve", help="run the HTTP server")
    serve_parser.add_argument("--data-dir", required=True)
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", type=int, default=8787)
    serve_parser.add_argument(
        "--keep",
        type=int,
        default=None,
        help=(
            "background GC after each snapshot: keep the latest N snapshots "
            "per user (N<=0 or omitted disables automatic GC)"
        ),
    )
    serve_parser.add_argument(
        "--verbose",
        action="store_true",
        default=argparse.SUPPRESS,
        help="verbose logging",
    )
    serve_parser.set_defaults(func=cmd_serve)

    gc_parser = subparsers.add_parser("gc", help="mark-and-sweep snapshots and chunks")
    gc_parser.add_argument("--data-dir", required=True)
    gc_parser.add_argument("--keep", type=int, required=True)
    gc_parser.add_argument("--dry-run", action="store_true")
    gc_parser.add_argument(
        "--verbose",
        action="store_true",
        default=argparse.SUPPRESS,
    )
    gc_parser.set_defaults(func=cmd_gc)

    verify_parser = subparsers.add_parser(
        "verify",
        help="read-only full verification of packs, index and snapshots",
    )
    verify_parser.add_argument("--data-dir", required=True)
    verify_parser.add_argument("--user", default=None)
    verify_parser.add_argument("--json", action="store_true")
    verify_parser.add_argument(
        "--quarantine",
        action="store_true",
        help="remove damaged chunks from the index so clients can re-upload them",
    )
    verify_parser.add_argument(
        "--verbose",
        action="store_true",
        default=argparse.SUPPRESS,
    )
    verify_parser.set_defaults(func=cmd_verify)

    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        result = args.func(args)
    except ApiError as exc:
        print(f"error: {exc.message}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except EOFError:
        print(
            "error: admin password is required (use --admin-password in non-interactive mode)",
            file=sys.stderr,
        )
        return 1
    except KeyboardInterrupt:
        return 130
    if isinstance(result, int):
        return result
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
