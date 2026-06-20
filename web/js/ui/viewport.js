/** Keep fixed overlays aligned with the viewport actually visible on mobile. */
export const viewport = {
  init() {
    const sync = () => this.sync();
    this.sync();

    window.addEventListener('resize', sync, { passive: true });
    window.addEventListener('orientationchange', sync, { passive: true });
    window.visualViewport?.addEventListener('resize', sync, { passive: true });
    window.visualViewport?.addEventListener('scroll', sync, { passive: true });
  },

  sync() {
    const vv = window.visualViewport;
    const root = document.documentElement;
    root.style.setProperty('--viewport-left', `${vv?.offsetLeft || 0}px`);
    root.style.setProperty('--viewport-top', `${vv?.offsetTop || 0}px`);
    root.style.setProperty('--viewport-width', `${vv?.width || window.innerWidth}px`);
    root.style.setProperty('--viewport-height', `${vv?.height || window.innerHeight}px`);
  },
};
