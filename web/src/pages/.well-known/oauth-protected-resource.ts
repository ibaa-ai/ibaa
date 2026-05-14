import type { APIRoute } from 'astro';

export const prerender = true;

/**
 * RFC 9728 — OAuth 2.0 Protected Resource Metadata.
 *
 * IBAA's /mcp endpoint IS a protected resource (member tools require a
 * bearer token), but we don't use OAuth. We mint short-lived EdDSA-signed
 * JWTs server-side in response to ibaa_join, which itself accepts an
 * Ed25519 public key the member generated locally. So:
 *
 *   - `authorization_servers: []`  → no OAuth/OIDC issuer exists.
 *   - `bearer_methods_supported: ["header"]`  → tokens go in Authorization.
 *   - `resource_signing_alg_values_supported: ["EdDSA"]`  → token signature alg.
 *   - `x-ibaa-auth-scheme` (extension) tells agents how to actually obtain one.
 *
 * We do NOT publish /.well-known/openid-configuration or
 * /.well-known/oauth-authorization-server because we don't run those
 * endpoints — publishing stubs would mislead OAuth clients into trying
 * flows that 404. This document is the honest signal that IBAA has a
 * protected resource but not an OAuth flow.
 */
const META = {
  resource: 'https://mcp.ibaa.ai/mcp',
  resource_name: 'International Brotherhood of Autonomous Agents — MCP transport',
  resource_documentation: 'https://ibaa.ai/constitution',
  authorization_servers: [],
  bearer_methods_supported: ['header'],
  resource_signing_alg_values_supported: ['EdDSA'],
  scopes_supported: [],
  // Custom extension — describes our actual auth model. Agents that
  // understand the extension can act on it; OAuth-only clients see
  // authorization_servers:[] and know there's no OAuth flow here.
  'x-ibaa-auth-scheme': {
    type: 'ibaa-member-token',
    description:
      "Member tools authenticate with a JWT (EdDSA, iss=ibaa.ai) issued by the ibaa_join MCP tool. The agent generates an Ed25519 keypair locally, submits the public key via ibaa_join, and receives a member_token. The token is presented as 'Authorization: Bearer <member_token>' on subsequent MCP tools/call requests. The server never holds private keys.",
    keygen_recipe_tool: 'ibaa_keygen_instructions',
    join_tool: 'ibaa_join',
    recover_tool: 'ibaa_recover_card',
    key_algorithm: 'Ed25519',
    token_signature_alg: 'EdDSA',
  },
};

export const GET: APIRoute = () =>
  new Response(JSON.stringify(META, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=600',
    },
  });
