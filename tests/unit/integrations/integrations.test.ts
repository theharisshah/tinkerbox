import { describe, expect, it } from 'vitest'
import { editorUrl } from '../../../src/main/integrations/editorLinks'
import { createGist } from '../../../src/main/integrations/gist'

describe('editorUrl', () => {
  it('builds per-editor deep links', () => {
    expect(editorUrl('vscode', '/Users/me/app/routes/web.php', 12)).toBe('vscode://file/Users/me/app/routes/web.php:12')
    expect(editorUrl('cursor', '/a/b.php')).toBe('cursor://file/a/b.php')
    expect(editorUrl('zed', '/a/b.php', 3)).toBe('zed://file/a/b.php:3')
    expect(editorUrl('phpstorm', '/a/b c.php', 5)).toBe('phpstorm://open?file=%2Fa%2Fb%20c.php&line=5')
    expect(editorUrl('sublime', '/a/b.php', 2)).toBe('subl://open?url=file%3A%2F%2F%2Fa%2Fb.php&line=2')
    expect(editorUrl('none', '/a/b.php', 2)).toBeNull()
  })

  it('encodes spaces and handles Windows paths', () => {
    expect(editorUrl('vscode', '/Users/me/My App/x.php', 1)).toBe('vscode://file/Users/me/My%20App/x.php:1')
    expect(editorUrl('vscode', 'C:\\Users\\me\\app\\x.php', 4)).toBe('vscode://file/C:/Users/me/app/x.php:4')
  })
})

describe('createGist', () => {
  it('posts the code and returns the html url', async () => {
    let sent: { url: string; body: { files: Record<string, { content: string }>; public: boolean } } | null = null
    const fake = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) }
      return new Response(JSON.stringify({ html_url: 'https://gist.github.com/x/1' }), { status: 201 })
    }) as unknown as typeof fetch
    const url = await createGist('tok', '<?php echo 1;', 'demo', false, fake)
    expect(url).toBe('https://gist.github.com/x/1')
    expect(sent!.url).toBe('https://api.github.com/gists')
    expect(sent!.body.public).toBe(false)
    expect(sent!.body.files['tinkerbox.php'].content).toBe('<?php\n\necho 1;')
  })

  it('maps auth errors and requires a token', async () => {
    const fake = (async () => new Response('', { status: 401 })) as unknown as typeof fetch
    await expect(createGist('bad', 'echo 1;', '', true, fake)).rejects.toThrow(/401/)
    await expect(createGist('', 'echo 1;', '', true, fake)).rejects.toThrow(/token/)
  })
})
