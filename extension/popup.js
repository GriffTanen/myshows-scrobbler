// Unofficial, experimental companion to myshows-scrobbler's auto-confirm feature.
// Reads the myshows.me session cookie (httpOnly — inaccessible to page scripts, hence
// this being an extension rather than a bookmarklet) via chrome.cookies, which is
// allowed to read httpOnly cookies for origins the extension has host permission on.

const COOKIE_URL = 'https://myshows.me'
const COOKIE_NAME = 'msRefreshToken'

const hostInput = document.getElementById('host')
const statusEl = document.getElementById('status')
const connectBtn = document.getElementById('connect')

function setStatus(text, kind) {
  statusEl.textContent = text
  statusEl.className = kind
}

chrome.storage.local.get(['serverHost'], (data) => {
  if (data.serverHost) {
    hostInput.value = data.serverHost
  }
})

connectBtn.addEventListener('click', async () => {
  const host = hostInput.value.trim().replace(/\/+$/, '')
  if (!host) {
    setStatus('Укажите адрес сервера', 'err')
    return
  }
  await chrome.storage.local.set({ serverHost: host })

  connectBtn.disabled = true
  setStatus('Проверяю сессию…', '')

  try {
    const cookie = await chrome.cookies.get({ url: COOKIE_URL, name: COOKIE_NAME })
    if (!cookie) {
      setStatus('Не залогинен на myshows.me — войдите на сайте и попробуйте снова', 'err')
      return
    }

    const url = /^https?:\/\//.test(host)
      ? `${host}/api/auth/myshows-bookmarklet`
      : `http://${host}/api/auth/myshows-bookmarklet`

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: cookie.value }),
    })

    if (res.ok) {
      setStatus('Готово! Сессия подключена.', 'ok')
    } else {
      setStatus(`Сервер отклонил запрос: ${res.status}`, 'err')
    }
  } catch (err) {
    setStatus(`Не удалось достучаться до сервера: ${err.message}`, 'err')
  } finally {
    connectBtn.disabled = false
  }
})
