import { ServerAuth } from "../auth"
import { UnauthorizedError } from "@opencode-ai/protocol/errors"
import { Authorization } from "@opencode-ai/protocol/middleware/authorization"
export { Authorization } from "@opencode-ai/protocol/middleware/authorization"
import { hasPtyConnectTicketURL } from "@opencode-ai/protocol/groups/pty"
import { Effect, Encoding, Layer, Redacted } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

const AUTH_TOKEN_QUERY = "auth_token"
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

function emptyCredential() {
  return { username: "", password: Redacted.make("") }
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return { username: header.slice(0, separator), password: Redacted.make(header.slice(separator + 1)) }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  const url = new URL(request.url, "http://localhost")
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

function accessTokenFromRequest(request: HttpServerRequest.HttpServerRequest) {
  return ServerAuth.accessTokenFromRequest({
    authorization: request.headers.authorization,
    url: new URL(request.url, "http://localhost"),
  })
}

function unauthorized() {
  return Effect.gen(function* () {
    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
    )
    return yield* new UnauthorizedError({ message: "Authentication required" })
  })
}

function validateToken<A, E, R>(effect: Effect.Effect<A, E, R>, token: string) {
  return Effect.gen(function* () {
    if (yield* Effect.promise(() => ServerAuth.tokens.verifyAccess(token))) return yield* effect
    return yield* unauthorized()
  })
}

function validateCredential<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
) {
  return Effect.gen(function* () {
    if (!ServerAuth.required(config)) return yield* effect
    if (!ServerAuth.authorized(credential, config)) return yield* unauthorized()
    return yield* effect
  })
}

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    if (!ServerAuth.required(config)) return Authorization.of((effect) => effect)
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (ServerAuth.isPublicAuthPath(request.method, url.pathname)) return yield* effect
        // Browsers cannot set headers on WebSocket upgrades, so a ticketed PTY connect skips
        // credential checks here; the connect handler consumes and validates the ticket.
        if (hasPtyConnectTicketURL(url)) return yield* effect
        const accessToken = accessTokenFromRequest(request)
        if (accessToken) return yield* validateToken(effect, accessToken)
        const credential = yield* credentialFromRequest(request)
        return yield* validateCredential(effect, credential, config)
      }),
    )
  }),
)
