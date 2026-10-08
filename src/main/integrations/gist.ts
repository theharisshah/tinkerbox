/**
 * "Share as Gist": creates a GitHub Gist from the editor code (no hosted share service
 * needed). Requires a GitHub token with the `gist` scope (Settings → Advanced).
 */
export async function createGist(
  token: string,
  code: string,
  description: string,
  isPublic: boolean,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  if (!token) throw new Error('Add a GitHub token with the "gist" scope in Settings → Advanced to share code.')
  if (!code.trim()) throw new Error('There is no code to share.')

  const body = code.replace(/^\s*<\?php\s*/, '')
  let response: Response
  try {
    response = await fetchImpl('https://api.github.com/gists', {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Tinkerbox',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        description: description.trim() || 'Shared from Tinkerbox',
        public: isPublic,
        files: { 'tinkerbox.php': { content: `<?php\n\n${body}` } }
      }),
      signal: AbortSignal.timeout(20000)
    })
  } catch (error) {
    throw new Error(`Could not reach GitHub: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (response.status === 401) throw new Error('GitHub rejected the token (401). Check the token in Settings → Advanced.')
  if (response.status === 403 || response.status === 404) {
    throw new Error('The GitHub token is missing the "gist" scope or is not allowed to create gists.')
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`GitHub returned ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
  }
  const json = (await response.json()) as { html_url?: string }
  if (!json.html_url) throw new Error('GitHub did not return a gist URL.')
  return json.html_url
}
