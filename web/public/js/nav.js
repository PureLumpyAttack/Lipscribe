// Top-bar dropdown: opens on click, closes on outside click, Escape, or picking a link.

for (const menu of document.querySelectorAll('[data-menu]')) {
  const trigger = menu.querySelector('.menu-trigger');
  const panel = menu.querySelector('.menu-panel');

  const setOpen = (open) => {
    trigger.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
  };

  trigger.addEventListener('click', () => setOpen(panel.hidden));
  panel.addEventListener('click', (event) => event.target.closest('a') && setOpen(false));
  document.addEventListener('click', (event) => !menu.contains(event.target) && setOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) {
      setOpen(false);
      trigger.focus();
    }
  });
}
