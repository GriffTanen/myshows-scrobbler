// Unofficial, experimental companion to myshows-scrobbler's auto-confirm feature.
// Reads the myshows.me session cookie (httpOnly — inaccessible to page scripts, hence
// this being an extension rather than a bookmarklet) via chrome.cookies, which is
// allowed to read httpOnly cookies for origins the extension has host permission on.

const COOKIE_URL = 'https://myshows.me'
const COOKIE_NAME = 'msRefreshToken'

const hostInput = document.getElementById('host')
const statusEl = document.getElementById('status')
const transportHintEl = document.getElementById('transport-hint')
const connectBtn = document.getElementById('connect')

function setStatus(text, kind) {
  statusEl.textContent = text
  statusEl.className = kind
}

/** Resolve the entered host to the full endpoint URL (defaulting to http:// on a LAN). */
function endpointUrl(host) {
  const base = /^https?:\/\//.test(host) ? host : `http://${host}`
  return `${base}/api/auth/myshows-bookmarklet`
}

/**
 * The refresh token is POSTed in the request body. Over plain http it travels in the clear —
 * fine on a trusted LAN, worth flagging otherwise. localhost/loopback is always safe.
 * Shown as a persistent hint under the input (updated as you type), not a flash in the status
 * line, so the warning is visible *before* connecting rather than overwritten by the result.
 */
function updateTransportHint() {
  const host = hostInput.value.trim().replace(/\/+$/, '')
  if (!host) {
    transportHintEl.textContent = ''
    return
  }
  const url = endpointUrl(host)
  const isSecure = /^https:\/\//.test(url)
  const isLocal = /^https?:\/\/(localhost|127\.|\[::1\])/.test(url)
  transportHintEl.textContent =
    isSecure || isLocal ? '' : '⚠ Токен уйдёт по незашифрованному http — ок для локальной сети.'
}

chrome.storage.local.get(['serverHost'], (data) => {
  if (data.serverHost) {
    hostInput.value = data.serverHost
    updateTransportHint()
  }
})

hostInput.addEventListener('input', updateTransportHint)

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

    const res = await fetch(endpointUrl(host), {
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
