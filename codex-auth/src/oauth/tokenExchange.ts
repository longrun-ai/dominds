export async function exchangeCodeForTokens(
  issuer: string,
  clientId: string,
  redirectUri: string,
  codeVerifier: string,
  code: string,
): Promise<{ idToken: string; accessToken: string; refreshToken: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });

  const response = await fetch(`${issuer}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`token endpoint returned status ${response.status}`);
  }

  const json = (await response.json()) as {
    id_token: string;
    access_token: string;
    refresh_token: string;
  };

  return {
    idToken: json.id_token,
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
  };
}

export async function obtainApiKey(
  issuer: string,
  clientId: string,
  idToken: string,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    client_id: clientId,
    requested_token: 'openai-api-key',
    subject_token: idToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
  });

  const response = await fetch(`${issuer}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`api key exchange failed with status ${response.status}`);
  }

  const json = (await response.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error('api key exchange response missing access_token');
  }
  return json.access_token;
}
