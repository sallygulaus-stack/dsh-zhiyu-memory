/**
 * DSH web client side: a small floating entry point for the memory observer.
 *
 * The full observer remains available at /companion-memory/console as a
 * fallback. This client layer only adds a local overlay and never sends
 * memory data outside the current DSH origin.
 */
window.__ModuleLoader__.load({
  id: 'dsh-zhiyu-memory',
  factory: (require) => {
    const STYLE = `
      .zym-fab{position:fixed;z-index:2147483000;right:22px;top:96px;width:42px;height:42px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#3b4550) 85%,transparent);border-radius:50%;background:var(--dsw-alias-bg-layer-2,#202832);color:var(--dsw-alias-label-primary,#edf2f7);box-shadow:0 8px 24px rgba(0,0,0,.28);display:grid;place-items:center;cursor:pointer;transition:transform .15s ease,border-color .15s ease,background .15s ease}
      .zym-fab:hover{transform:translateY(-1px);border-color:var(--dsw-alias-brand-primary,#7dd3c7);background:var(--dsw-alias-bg-layer-3,#28323d)}
      .zym-fab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#7dd3c7);outline-offset:3px}.zym-fab svg{width:20px;height:20px}
      .zym-scrim{position:fixed;inset:0;z-index:2147482998;background:rgba(0,0,0,.34)}
      .zym-window{position:fixed;z-index:2147482999;top:76px;right:76px;width:min(920px,calc(100vw - 110px));height:min(760px,calc(100vh - 112px));min-width:360px;min-height:420px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1,#303b47);border-radius:12px;background:var(--dsw-alias-bg-base,#11151a);box-shadow:0 20px 60px rgba(0,0,0,.48);display:flex;flex-direction:column}
      .zym-window-head{flex:0 0 44px;display:flex;align-items:center;justify-content:space-between;padding:0 12px 0 16px;border-bottom:1px solid var(--dsw-alias-border-l1,#303b47);color:var(--dsw-alias-label-primary,#edf2f7);font-size:13px;font-weight:600}
      .zym-window-actions{display:flex;gap:6px;align-items:center}.zym-window-btn{width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#9ba8b7);cursor:pointer}
      .zym-window-btn:hover{background:var(--dsw-alias-bg-layer-2,#202832);color:var(--dsw-alias-label-primary,#edf2f7)}.zym-frame{flex:1 1 auto;width:100%;border:0;background:#11151a}
      @media(max-width:700px){.zym-fab{right:12px;top:84px}.zym-window{top:60px;right:8px;width:calc(100vw - 16px);height:calc(100vh - 76px);min-width:0}}
    `
    const ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4" stroke="currentColor" stroke-width="1.7"/><path d="M8 9h8M8 12h5M8 15h3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'
    const CLOSE = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
    const POP = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 16 16 8M10 8h6v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'

    function openPanel() {
      if (document.querySelector('[data-dsh-zhiyu-memory-window]')) return
      const scrim = document.createElement('div')
      scrim.className = 'zym-scrim'
      scrim.dataset.dshZhiyuMemoryWindow = 'scrim'
      const panel = document.createElement('section')
      panel.className = 'zym-window'
      panel.dataset.dshZhiyuMemoryWindow = 'panel'
      panel.setAttribute('role', 'dialog')
      panel.setAttribute('aria-label', '小鱼记忆观察')
      panel.innerHTML = `
        <header class="zym-window-head"><span>小鱼记忆观察</span><span class="zym-window-actions">
          <button class="zym-window-btn" type="button" data-zym-pop title="在新页面打开" aria-label="在新页面打开">${POP}</button>
          <button class="zym-window-btn" type="button" data-zym-close title="关闭" aria-label="关闭">${CLOSE}</button>
        </span></header>
        <iframe class="zym-frame" title="小鱼记忆观察内容" src="/companion-memory/console?embed=1"></iframe>
      `
      const close = () => { scrim.remove(); panel.remove() }
      scrim.addEventListener('click', close)
      panel.querySelector('[data-zym-close]').addEventListener('click', close)
      panel.querySelector('[data-zym-pop]').addEventListener('click', () => {
        window.open('/companion-memory/console', '_blank', 'noopener,noreferrer')
      })
      document.body.append(scrim, panel)
      panel.querySelector('[data-zym-close]').focus()
    }

    function apply(ctx) {
      if (typeof document === 'undefined' || !document.body || document.querySelector('[data-dsh-zhiyu-memory-fab]')) return
      const style = document.createElement('style')
      style.dataset.dshZhiyuMemoryClient = '1'
      style.textContent = STYLE
      document.head.appendChild(style)
      const fab = document.createElement('button')
      fab.className = 'zym-fab'
      fab.dataset.dshZhiyuMemoryFab = '1'
      fab.type = 'button'
      fab.title = '打开小鱼记忆观察'
      fab.setAttribute('aria-label', '打开小鱼记忆观察')
      fab.innerHTML = ICON
      fab.addEventListener('click', openPanel)
      document.body.appendChild(fab)
      if (typeof ctx?.effect === 'function') {
        ctx.effect(() => () => {
          fab.remove()
          style.remove()
          document.querySelectorAll('[data-dsh-zhiyu-memory-window]').forEach((node) => node.remove())
        }, 'dsh-zhiyu-memory: floating observer')
      }
    }

    return { apply, inject: [] }
  },
})
