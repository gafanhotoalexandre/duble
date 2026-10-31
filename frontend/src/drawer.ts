// O dialog mantém modalidade, foco e backdrop durante TODA a animação de saída.
// close() só acontece após a transição, preservando a animação de saída.
const dialog = document.getElementById("response-inspector") as HTMLDialogElement;
let previouslyFocused: HTMLElement | null = null;
let closing = false;
let transitionId = 0;

export function openDrawer(
  panelId: string,
  context: string,
  title: string,
  description: string,
): void {
  transitionId += 1;
  closing = false;
  dialog.removeAttribute("aria-busy");
  const body = document.getElementById("drawer-body") as HTMLElement;
  (document.getElementById("drawer-context") as HTMLElement).textContent = context;
  (document.getElementById("inspector-title") as HTMLElement).textContent = title;
  (document.getElementById("inspector-description") as HTMLElement).textContent = description;
  // Painéis persistentes preservam bindings dos exemplos e o registro inspecionado.
  for (const panel of body.children)
    if (panel instanceof HTMLElement) panel.hidden = panel.id !== panelId;
  body.scrollTop = 0;
  if (!dialog.open) {
    previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.documentElement.classList.add("has-drawer");
    dialog.showModal();
    // Estabelece o frame inicial antes de aplicar a transformação final.
    void dialog.offsetWidth;
  }
  dialog.dataset.visible = "true";
  (document.getElementById("close-drawer") as HTMLButtonElement).focus({ preventScroll: true });
}

export async function closeDrawer(): Promise<void> {
  if (!dialog.open || closing) return;
  closing = true;
  const thisTransition = ++transitionId;
  dialog.dataset.visible = "false";
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    // getAnimations inclui a transição recém-criada, sem timer arbitrário.
    await Promise.allSettled(dialog.getAnimations().map((animation) => animation.finished));
  }
  if (thisTransition !== transitionId) return;
  dialog.close();
  closing = false;
  document.documentElement.classList.remove("has-drawer");
  if (previouslyFocused?.isConnected && previouslyFocused.getClientRects().length)
    previouslyFocused.focus({ preventScroll: true });
  else document.getElementById("open-history")?.focus({ preventScroll: true });
}

export function setupDrawer(): void {
  document.getElementById("close-drawer")?.addEventListener("click", () => {
    void closeDrawer();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    void closeDrawer();
  });
  let backdropDown = false;
  function outside(event: MouseEvent): boolean {
    const rect = dialog.getBoundingClientRect();
    return (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    );
  }
  dialog.addEventListener("pointerdown", (event) => {
    backdropDown = event.target === dialog && outside(event);
  });
  dialog.addEventListener("click", (event) => {
    if (backdropDown && event.target === dialog && outside(event)) void closeDrawer();
    backdropDown = false;
  });
}
