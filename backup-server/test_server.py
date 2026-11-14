#!/usr/bin/env python3
"""unittest suite for the OpenCode backup server."""

from __future__ import annotations

import base64
import contextlib
import glob
import hashlib
import http.client
import io
import json
import os
import re
import sqlite3
import struct
import tempfile
import threading
import time
import unittest
from urllib.parse import urlencode

import server


ADMIN_PASSWORD = "admin-test-password"
USER_TOKEN = "test-user-token-0123456789"
PASSWORD = "user-test-password"


def basic_header(user, password):
    token = base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")
    return "Basic " + token


class ServerTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = os.path.join(self.tmp.name, "data")
        server.init_data_dir(self.data_dir, admin_password=ADMIN_PASSWORD)
        server.create_user(self.data_dir, "alice", token=USER_TOKEN)
        self.server = None
        self.thread = None
        self.port = None
        self._start_server()

    def tearDown(self):
        self._stop_server()
        self.tmp.cleanup()

    def _start_server(self, auto_gc_keep=None):
        self.server = server.make_server(
            self.data_dir, port=0, auto_gc_keep=auto_gc_keep
        )
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            daemon=True,
        )
        self.thread.start()

    def _stop_server(self):
        if self.server is None:
            return
        self.server.shutdown()
        self.server.server_close()
        self.server.store.close()
        if self.thread is not None:
            self.thread.join(timeout=5)
        self.server = None
        self.thread = None
        self.port = None

    def request(
        self,
        method,
        path,
        body=None,
        token=USER_TOKEN,
        headers=None,
        auth=True,
    ):
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.port, timeout=20
        )
        request_headers = dict(headers or {})
        if auth and token is not None:
            request_headers.setdefault("Authorization", "Bearer " + token)
        if body is not None:
            if isinstance(body, str):
                body = body.encode("utf-8")
            request_headers.setdefault("Content-Length", str(len(body)))
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        data = response.read()
        response_headers = {
            key.lower(): value for key, value in response.getheaders()
        }
        connection.close()
        return response.status, response_headers, data

    def request_json(self, method, path, body=None, token=USER_TOKEN, headers=None, auth=True):
        status, response_headers, data = self.request(
            method, path, body=body, token=token, headers=headers, auth=auth
        )
        parsed = json.loads(data) if data else None
        return status, response_headers, parsed

    def upload_chunk(self, user, raw, token=USER_TOKEN):
        sha = hashlib.sha256(raw).hexdigest()
        status, _, data = self.request(
            "PUT",
            f"/v1/users/{user}/chunks/{sha}",
            body=raw,
            token=token,
            headers={"Content-Type": "application/octet-stream"},
        )
        return status, sha, data

    def make_manifest(self, snapshot_id, created_at, file_name, chunks):
        data = b"".join(chunks)
        return {
            "version": 1,
            "id": snapshot_id,
            "created_at": created_at,
            "source": {"hostname": "test-host", "opencode_version": "1.0.0"},
            "files": [
                {
                    "path": file_name,
                    "size": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "chunks": [hashlib.sha256(chunk).hexdigest() for chunk in chunks],
                }
            ],
            "total_bytes": len(data),
        }

    def create_snapshot(self, manifest, token=USER_TOKEN):
        return self.request_json(
            "POST",
            "/v1/users/alice/snapshots",
            body=json.dumps(manifest),
            token=token,
            headers={"Content-Type": "application/json"},
        )

    # -- admin helpers -------------------------------------------------

    def admin_login_page(self, cookie=None):
        headers = {"Cookie": cookie} if cookie else None
        status, response_headers, data = self.request(
            "GET", "/admin", headers=headers, auth=False
        )
        self.assertEqual(status, 200)
        match = re.search(rb'name="_csrf" value="([^"]+)"', data)
        self.assertIsNotNone(match)
        csrf = match.group(1).decode("ascii")
        set_cookie = response_headers.get("set-cookie")
        if set_cookie:
            cookie = set_cookie.split(";", 1)[0]
        self.assertIsNotNone(cookie)
        return csrf, cookie, data

    def admin_login(self, password=ADMIN_PASSWORD):
        csrf, cookie, _ = self.admin_login_page()
        body = urlencode({"_csrf": csrf, "password": password}).encode("utf-8")
        status, response_headers, _ = self.request(
            "POST",
            "/admin/login",
            body=body,
            headers={
                "Cookie": cookie,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            auth=False,
        )
        new_cookie = response_headers.get("set-cookie")
        if new_cookie:
            new_cookie = new_cookie.split(";", 1)[0]
        return status, new_cookie, csrf, cookie

    def admin_dashboard(self):
        status, new_cookie, _csrf, _old = self.admin_login()
        self.assertEqual(status, 303)
        self.assertIsNotNone(new_cookie)
        status, _, data = self.request(
            "GET", "/admin", headers={"Cookie": new_cookie}, auth=False
        )
        self.assertEqual(status, 200)
        match = re.search(rb'name="_csrf" value="([^"]+)"', data)
        self.assertIsNotNone(match)
        return new_cookie, match.group(1).decode("ascii"), data

    def admin_post(self, cookie, path, fields):
        body = urlencode(fields).encode("utf-8")
        return self.request(
            "POST",
            path,
            body=body,
            headers={
                "Cookie": cookie,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            auth=False,
        )

    # -- pack helpers --------------------------------------------------

    def pack_paths(self, user="alice"):
        return sorted(
            glob.glob(
                os.path.join(self.data_dir, "users", user, "packs", "*.pack")
            )
        )

    def corrupt_first_record(self, user="alice"):
        packs = self.pack_paths(user)
        self.assertTrue(packs)
        path = packs[0]
        with open(path, "r+b") as handle:
            header = handle.read(server.PACK_HEADER.size)
            magic, sha_raw, raw_len, stored_len, crc = server.PACK_HEADER.unpack(
                header
            )
            self.assertEqual(magic, server.PACK_MAGIC)
            self.assertGreater(stored_len, 8)
            position = server.PACK_HEADER.size + stored_len // 2
            handle.seek(position)
            original = handle.read(1)
            handle.seek(position)
            handle.write(bytes([original[0] ^ 0xFF]))
            handle.flush()
            os.fsync(handle.fileno())
        return path, sha_raw.hex(), server.PACK_HEADER.size, stored_len

    @staticmethod
    def file_hash(path):
        with open(path, "rb") as handle:
            return hashlib.sha256(handle.read()).hexdigest()

    # -- tests ---------------------------------------------------------

    def test_health_and_auth(self):
        status, _, data = self.request("GET", "/v1/health", auth=False)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data), {"ok": True, "version": "1"})

        status, _, data = self.request("GET", "/v1/users/alice/snapshots", auth=False)
        self.assertEqual(status, 401)
        self.assertEqual(json.loads(data)["error"]["code"], "unauthorized")

        status, _, _ = self.request(
            "GET",
            "/v1/users/alice/snapshots",
            token="wrong-token",
        )
        self.assertEqual(status, 401)

        status, _, data = self.request_json(
            "GET", "/v1/users/alice/snapshots"
        )
        self.assertEqual(status, 200)
        self.assertEqual(data, {"snapshots": []})

        status, _, _ = self.request("POST", "/v1/health", auth=False)
        self.assertEqual(status, 405)

        status, _, data = self.request_json("GET", "/v1/unknown")
        self.assertEqual(status, 404)
        self.assertEqual(data["error"]["code"], "not_found")

    def test_adduser_generated_token_and_storage(self):
        token = server.create_user(self.data_dir, "bob")
        self.assertTrue(token)
        self.assertGreaterEqual(len(token), 32)
        with open(os.path.join(self.data_dir, "users.json"), "rb") as handle:
            raw = handle.read()
        self.assertNotIn(token.encode("utf-8"), raw)
        self.assertIn(b"token_hash", raw)

        status, _, _ = self.request(
            "GET", "/v1/users/bob/snapshots", token=token
        )
        self.assertEqual(status, 200)

        with self.assertRaises(server.ApiError) as raised:
            server.create_user(self.data_dir, "bob")
        self.assertEqual(raised.exception.code, "user_exists")

        with self.assertRaises(server.ApiError):
            server.create_user(self.data_dir, "BOB")
        users = server.UserStore(self.data_dir).list_users()
        self.assertIn("bob", [item["user"] for item in users])

    def test_chunk_upload_dedupe_and_download(self):
        raw = b"hello chunk" * 500
        sha = hashlib.sha256(raw).hexdigest()
        status, _, _ = self.upload_chunk("alice", raw)
        self.assertEqual(status, 201)
        status, _, _ = self.upload_chunk("alice", raw)
        self.assertEqual(status, 204)
        status, response_headers, data = self.request(
            "GET", f"/v1/users/alice/chunks/{sha}"
        )
        self.assertEqual(status, 200)
        self.assertEqual(data, raw)
        self.assertEqual(response_headers["content-type"], "application/octet-stream")
        self.assertEqual(len(self.pack_paths()), 1)

        wrong_sha = "0" * 64
        status, _, data = self.request_json(
            "PUT",
            f"/v1/users/alice/chunks/{wrong_sha}",
            body=raw,
            headers={"Content-Type": "application/octet-stream"},
        )
        self.assertEqual(status, 400)
        self.assertEqual(data["error"]["code"], "sha256_mismatch")

    def test_head_chunk_exists_without_body(self):
        raw = b"head check chunk"
        sha = hashlib.sha256(raw).hexdigest()

        status, _, body = self.request(
            "HEAD", f"/v1/users/alice/chunks/{sha}"
        )
        self.assertEqual(status, 404)
        self.assertEqual(body, b"")

        status, _, _ = self.upload_chunk("alice", raw)
        self.assertEqual(status, 201)
        status, headers, body = self.request(
            "HEAD", f"/v1/users/alice/chunks/{sha}"
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        self.assertEqual(headers.get("content-length"), "0")

        missing = "0" * 64
        status, _, body = self.request(
            "HEAD", f"/v1/users/alice/chunks/{missing}"
        )
        self.assertEqual(status, 404)
        self.assertEqual(body, b"")

        status, headers, body = self.request(
            "HEAD", f"/v1/users/alice/chunks/{sha}", auth=False
        )
        self.assertEqual(status, 401)
        self.assertEqual(body, b"")
        self.assertIn("www-authenticate", headers)

        server.create_user(self.data_dir, "bob", password=PASSWORD)
        status, _, _ = self.request(
            "PUT",
            f"/v1/users/bob/chunks/{sha}",
            body=raw,
            auth=False,
            headers={
                "Authorization": basic_header("bob", PASSWORD),
                "Content-Type": "application/octet-stream",
            },
        )
        self.assertEqual(status, 201)
        status, _, body = self.request(
            "HEAD",
            f"/v1/users/bob/chunks/{sha}",
            auth=False,
            headers={"Authorization": basic_header("bob", PASSWORD)},
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")

    def test_password_auth_with_basic(self):
        server.create_user(self.data_dir, "bob", password=PASSWORD)
        raw = b"basic auth chunk"
        sha = hashlib.sha256(raw).hexdigest()
        status, _, _ = self.request(
            "PUT",
            f"/v1/users/bob/chunks/{sha}",
            body=raw,
            auth=False,
            headers={
                "Authorization": basic_header("bob", PASSWORD),
                "Content-Type": "application/octet-stream",
            },
        )
        self.assertEqual(status, 201)
        status, _, _ = self.request(
            "GET",
            f"/v1/users/bob/chunks/{sha}",
            auth=False,
            headers={"Authorization": basic_header("bob", "wrong-password")},
        )
        self.assertEqual(status, 401)
        status, _, _ = self.request(
            "GET",
            f"/v1/users/bob/chunks/{sha}",
            auth=False,
            headers={"Authorization": basic_header("alice", PASSWORD)},
        )
        self.assertEqual(status, 401)
        status, _, data = self.request(
            "GET",
            f"/v1/users/bob/chunks/{sha}",
            auth=False,
            headers={"Authorization": basic_header("bob", PASSWORD)},
        )
        self.assertEqual(status, 200)
        self.assertEqual(data, raw)

    def test_snapshot_lifecycle_and_restore(self):
        chunks = [b"first chunk " * 100, b"second chunk " * 100]
        for chunk in chunks:
            status, _, _ = self.upload_chunk("alice", chunk)
            self.assertEqual(status, 201)
        manifest = self.make_manifest(
            "snap-001", "2026-01-01T10:00:00Z", "opencode.db", chunks
        )
        status, _, data = self.create_snapshot(manifest)
        self.assertEqual(status, 201)
        self.assertEqual(data["id"], "snap-001")

        status, _, data = self.create_snapshot(manifest)
        self.assertEqual(status, 409)
        self.assertEqual(data["error"]["code"], "snapshot_exists")

        status, _, data = self.request_json(
            "GET", "/v1/users/alice/snapshots"
        )
        self.assertEqual(status, 200)
        self.assertEqual(len(data["snapshots"]), 1)
        summary = data["snapshots"][0]
        self.assertEqual(summary["id"], "snap-001")
        self.assertEqual(summary["total_bytes"], manifest["total_bytes"])
        self.assertEqual(summary["file_count"], 1)
        self.assertEqual(summary["files"][0]["path"], "opencode.db")

        status, _, stored = self.request_json(
            "GET", "/v1/users/alice/snapshots/snap-001"
        )
        self.assertEqual(status, 200)
        self.assertEqual(stored["files"][0]["chunks"], manifest["files"][0]["chunks"])

        restored = b""
        for sha in stored["files"][0]["chunks"]:
            status, _, chunk = self.request(
                "GET", f"/v1/users/alice/chunks/{sha}"
            )
            self.assertEqual(status, 200)
            restored += chunk
        self.assertEqual(restored, b"".join(chunks))
        self.assertEqual(
            hashlib.sha256(restored).hexdigest(),
            stored["files"][0]["sha256"],
        )

        status, _, _ = self.request(
            "DELETE", "/v1/users/alice/snapshots/snap-001"
        )
        self.assertEqual(status, 204)
        status, _, _ = self.request_json(
            "GET", "/v1/users/alice/snapshots/snap-001"
        )
        self.assertEqual(status, 404)
        status, _, _ = self.request(
            "GET", f"/v1/users/alice/chunks/{stored['files'][0]['chunks'][0]}"
        )
        self.assertEqual(status, 200)

    def test_snapshot_rejects_missing_chunk_and_bad_size(self):
        chunk = b"abcdef" * 100
        status, sha, _ = self.upload_chunk("alice", chunk)
        self.assertEqual(status, 201)

        missing = "f" * 64
        manifest = {
            "version": 1,
            "id": "bad-1",
            "created_at": "2026-01-01T00:00:00Z",
            "source": {"hostname": "h", "opencode_version": "1"},
            "files": [
                {
                    "path": "opencode.db",
                    "size": len(chunk),
                    "sha256": hashlib.sha256(chunk).hexdigest(),
                    "chunks": [sha, missing],
                }
            ],
            "total_bytes": len(chunk),
        }
        status, _, data = self.create_snapshot(manifest)
        self.assertEqual(status, 400)
        self.assertEqual(data["error"]["code"], "missing_chunk")

        manifest["id"] = "bad-2"
        manifest["files"][0]["chunks"] = [sha]
        manifest["files"][0]["size"] = len(chunk) + 1
        manifest["total_bytes"] = len(chunk) + 1
        status, _, data = self.create_snapshot(manifest)
        self.assertEqual(status, 400)
        self.assertEqual(data["error"]["code"], "invalid_manifest")

        status, _, data = self.request_json(
            "GET", "/v1/users/alice/snapshots"
        )
        self.assertEqual(data, {"snapshots": []})

    def test_path_traversal_rejected(self):
        sha = "0" * 64
        cases = [
            f"/v1/users/../chunks/{sha}",
            f"/v1/users/%2e%2e/chunks/{sha}",
            f"/v1/users/..%2F..%2Fevil/chunks/{sha}",
            f"/v1/users/%2E%2E%5Cevil/chunks/{sha}",
            f"/v1/users/alice/chunks/..%2f..%2fusers.json",
            f"/v1/users/C%3A%5CWindows/chunks/{sha}",
        ]
        for path in cases:
            status, _, data = self.request("GET", path)
            self.assertIn(status, (400, 404), path)
            if data:
                self.assertIn("error", json.loads(data))

        status, _, _ = self.request("GET", "/v1/health", auth=False)
        self.assertEqual(status, 200)

    def test_pack_corruption_detected_on_read(self):
        raw = b"corrupt me " * 200
        status, sha, _ = self.upload_chunk("alice", raw)
        self.assertEqual(status, 201)
        self.server.store.flush_user("alice")
        path, _sha, _offset, _stored = self.corrupt_first_record()

        status, _, data = self.request_json(
            "GET", f"/v1/users/alice/chunks/{sha}"
        )
        self.assertEqual(status, 500)
        self.assertEqual(data["error"]["code"], "chunk_corrupt")
        self.assertTrue(os.path.exists(path))

    def test_gc_keeps_references_and_removes_unreferenced(self):
        chunk_a = b"A" * 4096
        chunk_b = b"B" * 4096
        status, sha_a, _ = self.upload_chunk("alice", chunk_a)
        self.assertEqual(status, 201)
        manifest_a = self.make_manifest(
            "snap-a", "2026-01-01T00:00:00Z", "a.db", [chunk_a]
        )
        self.assertEqual(self.create_snapshot(manifest_a)[0], 201)

        status, sha_b, _ = self.upload_chunk("alice", chunk_b)
        self.assertEqual(status, 201)
        manifest_b = self.make_manifest(
            "snap-b", "2026-01-02T00:00:00Z", "b.db", [chunk_b]
        )
        self.assertEqual(self.create_snapshot(manifest_b)[0], 201)

        old_packs = self.pack_paths()

        stats = self.server.store.gc(1, dry_run=True)
        self.assertTrue(stats["dry_run"])
        status, _, data = self.request_json(
            "GET", "/v1/users/alice/snapshots"
        )
        self.assertEqual({item["id"] for item in data["snapshots"]}, {"snap-a", "snap-b"})
        self.assertEqual(
            self.request("GET", f"/v1/users/alice/chunks/{sha_a}")[0], 200
        )
        self.assertEqual(
            self.request("GET", f"/v1/users/alice/chunks/{sha_b}")[0], 200
        )

        stats = self.server.store.gc(1, dry_run=False)
        self.assertFalse(stats["dry_run"])
        status, _, data = self.request_json(
            "GET", "/v1/users/alice/snapshots"
        )
        self.assertEqual([item["id"] for item in data["snapshots"]], ["snap-b"])
        status, _, _ = self.request_json(
            "GET", "/v1/users/alice/snapshots/snap-a"
        )
        self.assertEqual(status, 404)
        status, _, _ = self.request_json(
            "GET", f"/v1/users/alice/chunks/{sha_a}"
        )
        self.assertEqual(status, 404)
        status, _, data = self.request(
            "GET", f"/v1/users/alice/chunks/{sha_b}"
        )
        self.assertEqual(status, 200)
        self.assertEqual(data, chunk_b)

        new_packs = self.pack_paths()
        self.assertEqual(len(new_packs), 1)
        self.assertNotEqual(set(old_packs), set(new_packs))

        extra = b"after gc"
        status, sha_c, _ = self.upload_chunk("alice", extra)
        self.assertEqual(status, 201)
        self.assertEqual(
            self.request("GET", f"/v1/users/alice/chunks/{sha_c}")[2], extra
        )

    def test_automatic_gc_after_snapshot(self):
        keep = 2
        self._stop_server()
        self._start_server(auto_gc_keep=keep)

        chunks = []
        for index in range(keep + 2):
            raw = f"automatic gc chunk {index} ".encode("ascii") * 80
            status, sha, _ = self.upload_chunk("alice", raw)
            self.assertEqual(status, 201)
            chunks.append((sha, raw))

        for index, (_sha, raw) in enumerate(chunks):
            manifest = self.make_manifest(
                f"auto-{index}",
                f"2026-01-01T00:00:0{index}Z",
                f"file-{index}.db",
                [raw],
            )
            status, _, data = self.create_snapshot(manifest)
            self.assertEqual(status, 201)
            self.assertEqual(data["id"], f"auto-{index}")

        expected_ids = [f"auto-{keep + 1}", f"auto-{keep}"]
        deadline = time.time() + 20
        ids = []
        while time.time() < deadline:
            status, _, data = self.request_json(
                "GET", "/v1/users/alice/snapshots"
            )
            self.assertEqual(status, 200)
            ids = [item["id"] for item in data["snapshots"]]
            if ids == expected_ids:
                break
            time.sleep(0.1)
        self.assertEqual(ids, expected_ids)

        for index, (sha, raw) in enumerate(chunks):
            status, _, data = self.request(
                "GET", f"/v1/users/alice/chunks/{sha}"
            )
            if index < keep:
                self.assertEqual(
                    status, 404, f"chunk {index} should have been collected"
                )
            else:
                self.assertEqual(
                    status, 200, f"chunk {index} should still be referenced"
                )
                self.assertEqual(data, raw)

    def test_automatic_gc_disabled_for_non_positive_keep(self):
        self._stop_server()
        self._start_server(auto_gc_keep=-1)

        for index in range(3):
            raw = f"disabled auto gc {index} ".encode("ascii") * 40
            status, _sha, _ = self.upload_chunk("alice", raw)
            self.assertEqual(status, 201)
            manifest = self.make_manifest(
                f"disabled-{index}",
                f"2026-01-01T00:00:0{index}Z",
                f"disabled-{index}.db",
                [raw],
            )
            self.assertEqual(self.create_snapshot(manifest)[0], 201)

        time.sleep(0.3)
        status, _, data = self.request_json(
            "GET", "/v1/users/alice/snapshots"
        )
        self.assertEqual(status, 200)
        self.assertEqual(
            {item["id"] for item in data["snapshots"]},
            {"disabled-0", "disabled-1", "disabled-2"},
        )

    def test_truncated_pack_tail_does_not_crash(self):
        first = b"first record " * 200
        second = b"second record " * 200
        status, sha_first, _ = self.upload_chunk("alice", first)
        self.assertEqual(status, 201)
        status, sha_second, _ = self.upload_chunk("alice", second)
        self.assertEqual(status, 201)

        self._stop_server()
        packs = self.pack_paths()
        self.assertEqual(len(packs), 1)
        size = os.path.getsize(packs[0])
        with open(packs[0], "r+b") as handle:
            handle.truncate(size - 4)
            handle.flush()
            os.fsync(handle.fileno())

        self._start_server()
        status, _, _ = self.request("GET", "/v1/health", auth=False)
        self.assertEqual(status, 200)
        status, _, data = self.request(
            "GET", f"/v1/users/alice/chunks/{sha_first}"
        )
        self.assertEqual(status, 200)
        self.assertEqual(data, first)
        status, _, _ = self.request_json(
            "GET", f"/v1/users/alice/chunks/{sha_second}"
        )
        self.assertIn(status, (404, 500))

    def test_index_rebuilds_from_packs(self):
        raw = b"rebuild me " * 300
        status, sha, _ = self.upload_chunk("alice", raw)
        self.assertEqual(status, 201)
        manifest = self.make_manifest(
            "snap-rebuild", "2026-01-01T00:00:00Z", "opencode.db", [raw]
        )
        self.assertEqual(self.create_snapshot(manifest)[0], 201)

        self._stop_server()
        for suffix in ("", "-wal", "-shm"):
            path = os.path.join(self.data_dir, "index.sqlite3" + suffix)
            if os.path.exists(path):
                os.unlink(path)

        self._start_server()
        status, _, data = self.request(
            "GET", f"/v1/users/alice/chunks/{sha}"
        )
        self.assertEqual(status, 200)
        self.assertEqual(data, raw)
        status, _, data = self.request_json(
            "GET", "/v1/users/alice/snapshots"
        )
        self.assertEqual([item["id"] for item in data["snapshots"]], ["snap-rebuild"])

    def test_admin_login_and_csrf(self):
        csrf, cookie, body = self.admin_login_page()
        self.assertIn("管理员登录".encode("utf-8"), body)

        status, _, _ = self.admin_post(
            cookie,
            "/admin/login",
            {"_csrf": "wrong", "password": ADMIN_PASSWORD},
        )
        self.assertEqual(status, 403)

        status, _, _ = self.admin_post(
            cookie,
            "/admin/login",
            {"_csrf": csrf, "password": "wrong-password"},
        )
        self.assertEqual(status, 401)

        status, new_cookie, _, _ = self.admin_login()
        self.assertEqual(status, 303)
        self.assertIsNotNone(new_cookie)
        self.assertNotEqual(new_cookie.split("=", 1)[1], cookie.split("=", 1)[1])

        status, _, body = self.request(
            "GET", "/admin", headers={"Cookie": new_cookie}, auth=False
        )
        self.assertEqual(status, 200)
        self.assertIn("添加用户".encode("utf-8"), body)
        match = re.search(rb'name="_csrf" value="([^"]+)"', body)
        self.assertIsNotNone(match)
        csrf = match.group(1).decode("ascii")

        status, _, _ = self.request(
            "POST",
            "/admin/logout",
            body=urlencode({"_csrf": csrf}).encode("utf-8"),
            headers={
                "Cookie": new_cookie,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            auth=False,
        )
        self.assertEqual(status, 303)
        status, _, body = self.request(
            "GET", "/admin", headers={"Cookie": new_cookie}, auth=False
        )
        self.assertEqual(status, 200)
        self.assertIn("管理员登录".encode("utf-8"), body)

        status, _, _ = self.request(
            "GET", "/admin/users", headers={"Cookie": new_cookie}, auth=False
        )
        self.assertEqual(status, 405)

        status, _, body = self.request(
            "GET", "/admin", auth=False
        )
        self.assertEqual(status, 200)
        self.assertIn("管理员登录".encode("utf-8"), body)

    def test_admin_login_rate_limit(self):
        csrf, cookie, _body = self.admin_login_page()
        for _attempt in range(5):
            status, _, _ = self.admin_post(
                cookie,
                "/admin/login",
                {"_csrf": csrf, "password": "wrong-password"},
            )
            self.assertEqual(status, 401)
        status, _, _ = self.admin_post(
            cookie,
            "/admin/login",
            {"_csrf": csrf, "password": ADMIN_PASSWORD},
        )
        self.assertEqual(status, 429)

    def test_admin_creates_users_and_csrf_is_enforced(self):
        cookie, csrf, dashboard = self.admin_dashboard()
        self.assertIn("用户与用量".encode("utf-8"), dashboard)

        status, _, data = self.admin_post(
            cookie,
            "/admin/users",
            {"user": "no-csrf", "mode": "token"},
        )
        self.assertEqual(status, 403)
        self.assertFalse(server.UserStore(self.data_dir).user_exists("no-csrf"))

        status, _, _ = self.admin_post(
            cookie,
            "/admin/users",
            {"_csrf": csrf, "user": "carol", "mode": "token"},
        )
        self.assertEqual(status, 303)
        status, _, body = self.request(
            "GET", "/admin", headers={"Cookie": cookie}, auth=False
        )
        self.assertEqual(status, 200)
        match = re.search(rb'id="new-token">([^<]+)</code>', body)
        self.assertIsNotNone(match)
        carol_token = match.group(1).decode("ascii")
        self.assertEqual(
            self.request(
                "GET",
                "/v1/users/carol/snapshots",
                token=carol_token,
            )[0],
            200,
        )

        status, _, body = self.request(
            "GET", "/admin", headers={"Cookie": cookie}, auth=False
        )
        self.assertEqual(status, 200)
        self.assertNotIn(carol_token.encode("ascii"), body)

        status, _, _ = self.admin_post(
            cookie,
            "/admin/users/carol/password",
            {"_csrf": csrf, "password": PASSWORD},
        )
        self.assertEqual(status, 303)
        status, _, _ = self.request(
            "GET",
            "/v1/users/carol/snapshots",
            auth=False,
            headers={"Authorization": basic_header("carol", PASSWORD)},
        )
        self.assertEqual(status, 200)
        self.assertEqual(
            self.request(
                "GET", "/v1/users/carol/snapshots", token=carol_token
            )[0],
            200,
        )

        status, _, _ = self.admin_post(
            cookie,
            "/admin/users",
            {
                "_csrf": csrf,
                "user": "dave",
                "mode": "password",
                "password": PASSWORD,
            },
        )
        self.assertEqual(status, 303)
        raw = b"password user chunk"
        sha = hashlib.sha256(raw).hexdigest()
        status, _, _ = self.request(
            "PUT",
            f"/v1/users/dave/chunks/{sha}",
            body=raw,
            auth=False,
            headers={
                "Authorization": basic_header("dave", PASSWORD),
                "Content-Type": "application/octet-stream",
            },
        )
        self.assertEqual(status, 201)
        status, _, _ = self.request(
            "GET",
            f"/v1/users/dave/chunks/{sha}",
            auth=False,
            headers={"Authorization": basic_header("dave", "wrong")},
        )
        self.assertEqual(status, 401)

        status, _, _ = self.admin_post(
            cookie,
            "/admin/users/carol/disable",
            {"_csrf": csrf},
        )
        self.assertEqual(status, 303)
        status, _, _ = self.request(
            "GET", "/v1/users/carol/snapshots", token=carol_token
        )
        self.assertEqual(status, 401)
        status, _, _ = self.request(
            "GET",
            "/v1/users/carol/snapshots",
            auth=False,
            headers={"Authorization": basic_header("carol", PASSWORD)},
        )
        self.assertEqual(status, 401)

        status, _, _ = self.admin_post(
            cookie,
            "/admin/users/carol/delete",
            {"_csrf": csrf, "confirm": "carol"},
        )
        self.assertEqual(status, 303)
        status, _, _ = self.request(
            "GET", "/v1/users/carol/snapshots", token=carol_token
        )
        self.assertEqual(status, 401)
        self.assertFalse(
            os.path.isdir(os.path.join(self.data_dir, "users", "carol"))
        )

    def test_verify_healthy_data(self):
        raw = b"verify healthy " * 200
        status, sha, _ = self.upload_chunk("alice", raw)
        self.assertEqual(status, 201)
        manifest = self.make_manifest(
            "snap-verify", "2026-01-01T00:00:00Z", "opencode.db", [raw]
        )
        self.assertEqual(self.create_snapshot(manifest)[0], 201)
        self._stop_server()

        report = server.verify_data_dir(self.data_dir)
        self.assertTrue(report["ok"])
        user_report = report["users"]["alice"]
        self.assertFalse(user_report["corrupt_chunks"])
        self.assertEqual(user_report["healthy_indexed_chunks"], 1)
        self.assertEqual(user_report["index_records"], 1)

        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = server.main(
                ["verify", "--data-dir", self.data_dir, "--json"]
            )
        self.assertEqual(code, 0)
        parsed = json.loads(output.getvalue())
        self.assertTrue(parsed["ok"])
        self.assertEqual(parsed["users"]["alice"]["index_records"], 1)

    def test_verify_detects_corruption_and_does_not_modify_files(self):
        raw = b"verify corruption " * 200
        status, sha, _ = self.upload_chunk("alice", raw)
        self.assertEqual(status, 201)
        manifest = self.make_manifest(
            "snap-corrupt", "2026-01-01T00:00:00Z", "opencode.db", [raw]
        )
        self.assertEqual(self.create_snapshot(manifest)[0], 201)
        self._stop_server()

        pack_path, chunk_sha, payload_offset, _stored = self.corrupt_first_record()
        self.assertEqual(chunk_sha, sha)
        pack_before = self.file_hash(pack_path)
        users_before = self.file_hash(os.path.join(self.data_dir, "users.json"))
        snapshot_path = os.path.join(
            self.data_dir, "users", "alice", "snapshots", "snap-corrupt.json"
        )
        snapshot_before = self.file_hash(snapshot_path)

        report = server.verify_data_dir(self.data_dir)
        self.assertFalse(report["ok"])
        user_report = report["users"]["alice"]
        self.assertTrue(user_report["corrupt_chunks"])
        corrupt = user_report["corrupt_chunks"][0]
        self.assertEqual(corrupt["sha256"], sha)
        self.assertEqual(corrupt["pack"], os.path.basename(pack_path))
        self.assertEqual(corrupt["offset"], payload_offset)
        self.assertIn(corrupt["reason"], {"crc32", "zlib", "length", "sha256"})
        self.assertTrue(user_report["missing_chunks"])

        self.assertEqual(self.file_hash(pack_path), pack_before)
        self.assertEqual(
            self.file_hash(os.path.join(self.data_dir, "users.json")),
            users_before,
        )
        self.assertEqual(self.file_hash(snapshot_path), snapshot_before)

        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = server.main(
                ["verify", "--data-dir", self.data_dir, "--json"]
            )
        self.assertEqual(code, 1)
        self.assertFalse(json.loads(output.getvalue())["ok"])

    def test_verify_quarantine_allows_reupload(self):
        raw = b"quarantine me " * 200
        status, sha, _ = self.upload_chunk("alice", raw)
        self.assertEqual(status, 201)
        self.server.store.flush_user("alice")
        self._stop_server()

        pack_path, chunk_sha, _offset, _stored = self.corrupt_first_record()
        self.assertEqual(chunk_sha, sha)
        pack_before = self.file_hash(pack_path)

        report = server.verify_data_dir(
            self.data_dir, user="alice", quarantine=True
        )
        self.assertFalse(report["ok"])
        self.assertEqual(report["quarantine"], {"alice": 1})
        self.assertEqual(self.file_hash(pack_path), pack_before)

        index_path = os.path.join(self.data_dir, "index.sqlite3")
        connection = sqlite3.connect(index_path)
        try:
            count = connection.execute(
                "SELECT COUNT(*) FROM chunks WHERE username='alice'"
            ).fetchone()[0]
        finally:
            connection.close()
        self.assertEqual(count, 0)

        store = server.BackupStore(self.data_dir)
        try:
            with self.assertRaises(server.ApiError) as raised:
                store.get_chunk("alice", sha)
            self.assertEqual(raised.exception.status, 404)
            self.assertTrue(store.put_chunk("alice", raw, sha))
            self.assertEqual(store.get_chunk("alice", sha), raw)
        finally:
            store.close()

    def test_verify_reports_missing_index_entry(self):
        raw = b"unindexed record " * 200
        status, sha, _ = self.upload_chunk("alice", raw)
        self.assertEqual(status, 201)
        self.server.store.flush_user("alice")
        self._stop_server()

        index_path = os.path.join(self.data_dir, "index.sqlite3")
        connection = sqlite3.connect(index_path)
        try:
            connection.execute("DELETE FROM chunks WHERE username='alice'")
            connection.commit()
        finally:
            connection.close()

        report = server.verify_data_dir(self.data_dir)
        self.assertFalse(report["ok"])
        user_report = report["users"]["alice"]
        self.assertEqual(user_report["healthy_records"], 1)
        self.assertEqual(len(user_report["missing_index"]), 1)
        self.assertEqual(user_report["missing_index"][0]["sha256"], sha)
        self.assertEqual(user_report["orphan_records"][0]["kind"], "not_indexed")

    def test_verify_reports_index_metadata_mismatch(self):
        raw = b"index metadata mismatch " * 200
        status, sha, _ = self.upload_chunk("alice", raw)
        self.assertEqual(status, 201)
        self.server.store.flush_user("alice")
        self._stop_server()

        index_path = os.path.join(self.data_dir, "index.sqlite3")
        connection = sqlite3.connect(index_path)
        try:
            connection.execute(
                "UPDATE chunks SET stored_len = stored_len + 1 "
                "WHERE username='alice' AND sha256=?",
                (sha,),
            )
            connection.commit()
        finally:
            connection.close()

        pack_path = self.pack_paths()[0]
        pack_before = self.file_hash(pack_path)

        report = server.verify_data_dir(self.data_dir)
        self.assertFalse(report["ok"])
        user_report = report["users"]["alice"]
        self.assertEqual(user_report["corrupt_chunks"], [])
        self.assertTrue(user_report["index_mismatches"])
        self.assertEqual(user_report["index_mismatches"][0]["sha256"], sha)
        self.assertEqual(user_report["index_mismatches"][0]["reason"], "metadata")

        report = server.verify_data_dir(self.data_dir, quarantine=True)
        self.assertEqual(report["quarantine"], {"alice": 1})
        self.assertEqual(self.file_hash(pack_path), pack_before)
        connection = sqlite3.connect(index_path)
        try:
            count = connection.execute(
                "SELECT COUNT(*) FROM chunks WHERE username='alice'"
            ).fetchone()[0]
        finally:
            connection.close()
        self.assertEqual(count, 0)


if __name__ == "__main__":
    unittest.main()
