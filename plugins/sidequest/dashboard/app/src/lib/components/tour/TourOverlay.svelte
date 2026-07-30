<script lang="ts">
  import { tick } from 'svelte';
  import { getTourState } from '../../state/context';
  import type { TourStep } from '../../tour/steps';

  type Placement = NonNullable<TourStep['placement']>;
  interface TargetRect { top: number; right: number; bottom: number; left: number; width: number; height: number }

  const tour = getTourState();
  const margin = 12;
  const gap = 14;
  const spotlightPadding = 6;
  const opposite: Record<Placement, Placement> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

  let dialog = $state<HTMLDialogElement>();
  let card = $state<HTMLElement>();
  let nextButton = $state<HTMLButtonElement>();
  let targetRect = $state.raw<TargetRect | null>(null);
  let cardPosition = $state({ left: margin, top: margin });
  let detachTarget = () => {};
  let activation = 0;

  function releaseTarget() {
    detachTarget();
    detachTarget = () => {};
    targetRect = null;
  }

  function availablePlacement(rect: TargetRect): Placement {
    const spaces: Record<Placement, number> = {
      top: rect.top,
      bottom: window.innerHeight - rect.bottom,
      left: rect.left,
      right: window.innerWidth - rect.right
    };
    return (Object.entries(spaces) as [Placement, number][]).reduce((best, entry) => entry[1] > best[1] ? entry : best)[0];
  }

  function candidatePosition(rect: TargetRect, placement: Placement, width: number, height: number) {
    if (placement === 'top') return { left: rect.left + (rect.width - width) / 2, top: rect.top - gap - height };
    if (placement === 'bottom') return { left: rect.left + (rect.width - width) / 2, top: rect.bottom + gap };
    if (placement === 'left') return { left: rect.left - gap - width, top: rect.top + (rect.height - height) / 2 };
    return { left: rect.right + gap, top: rect.top + (rect.height - height) / 2 };
  }

  function overflowsMainAxis(position: { left: number; top: number }, placement: Placement, width: number, height: number) {
    if (placement === 'top') return position.top < margin;
    if (placement === 'bottom') return position.top + height > window.innerHeight - margin;
    if (placement === 'left') return position.left < margin;
    return position.left + width > window.innerWidth - margin;
  }

  function positionCard(rect: TargetRect | null, step: TourStep) {
    if (!card) return;
    const { width, height } = card.getBoundingClientRect();
    if (!rect) {
      cardPosition = {
        left: Math.max(margin, (window.innerWidth - width) / 2),
        top: Math.max(margin, (window.innerHeight - height) / 2)
      };
      return;
    }
    let placement = step.placement ?? availablePlacement(rect);
    let position = candidatePosition(rect, placement, width, height);
    if (overflowsMainAxis(position, placement, width, height)) {
      placement = opposite[placement];
      position = candidatePosition(rect, placement, width, height);
    }
    cardPosition = {
      left: Math.min(Math.max(position.left, margin), Math.max(margin, window.innerWidth - width - margin)),
      top: Math.min(Math.max(position.top, margin), Math.max(margin, window.innerHeight - height - margin))
    };
  }

  function attachToTarget(target: HTMLElement, step: TourStep) {
    const measure = () => {
      const bounds = target.getBoundingClientRect();
      targetRect = { top: bounds.top, right: bounds.right, bottom: bounds.bottom, left: bounds.left, width: bounds.width, height: bounds.height };
      positionCard(targetRect, step);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    detachTarget = () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
    target.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    measure();
  }

  async function activateStep(element: HTMLDialogElement, step: TourStep, index: number, run: number) {
    await tick();
    if (run !== activation || !tour.active || tour.index !== index || !element.isConnected) return;
    if (element.open) element.close();
    element.showModal();
    await tick();
    if (run !== activation || !tour.active || tour.index !== index) return;
    nextButton?.focus();
    const target = step.target ? document.querySelector<HTMLElement>(step.target) : null;
    if (target) attachToTarget(target, step);
    else positionCard(null, step);
  }

  function handleKeydown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.key === 'ArrowRight' || event.key === 'Enter') {
      event.preventDefault();
      tour.next();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      tour.prev();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      tour.skip();
    }
  }

  function handleCancel(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    tour.skip();
  }

  $effect(() => {
    const element = dialog;
    const step = tour.step;
    const index = tour.index;
    const active = tour.active;
    const run = ++activation;
    releaseTarget();
    if (!element) return;
    if (!active || !step) {
      if (element.open) element.close();
      return;
    }
    void activateStep(element, step, index, run);
    return () => {
      if (run !== activation) return;
      releaseTarget();
      if (element.open) element.close();
    };
  });
</script>

<dialog bind:this={dialog} aria-label="Product tour" onkeydown={handleKeydown} oncancel={handleCancel}>
  {#if tour.active && tour.step}
    {#if targetRect}
      <div
        class="spotlight"
        style:left={`${targetRect.left - spotlightPadding}px`}
        style:top={`${targetRect.top - spotlightPadding}px`}
        style:width={`${targetRect.width + spotlightPadding * 2}px`}
        style:height={`${targetRect.height + spotlightPadding * 2}px`}
      ></div>
    {/if}
    <section class="tour-card" bind:this={card} style:left={`${cardPosition.left}px`} style:top={`${cardPosition.top}px`}>
      <div class="counter">{tour.index + 1} of {tour.steps.length}</div>
      <div class="copy" aria-live="polite">
        <h2>{tour.step.title}</h2>
        <p>{tour.step.body}</p>
      </div>
      <div class="actions">
        <button class="skip" type="button" onclick={() => tour.skip()}>Skip</button>
        <span></span>
        <button type="button" disabled={tour.index === 0} onclick={() => tour.prev()}>Back</button>
        <button class="primary" type="button" bind:this={nextButton} onclick={() => tour.index === tour.steps.length - 1 ? tour.finish() : tour.next()}>{tour.index === tour.steps.length - 1 ? 'Finish' : 'Next'}</button>
      </div>
    </section>
  {/if}
</dialog>

<style>
  dialog { position: fixed; inset: 0; box-sizing: border-box; width: 100vw; height: 100dvh; max-width: none; max-height: none; margin: 0; padding: 0; overflow: hidden; border: 0; background: transparent; color: var(--text); }
  dialog:not([open]) { display: none; }
  dialog::backdrop { background: transparent; }
  .spotlight { position: absolute; box-sizing: border-box; pointer-events: none; border: 2px solid var(--accent); border-radius: 6px; box-shadow: 0 0 0 9999px color-mix(in oklch, var(--bg-deep), transparent 35%); transition: inset var(--motion-fast), width var(--motion-fast), height var(--motion-fast); }
  .tour-card { position: absolute; box-sizing: border-box; width: min(22rem, calc(100vw - 24px)); padding: 1.15rem; border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface-card); box-shadow: 0 16px 44px rgb(12 16 22 / .24), 0 2px 8px rgb(12 16 22 / .12); transition: left var(--motion-fast), top var(--motion-fast); }
  .counter { margin-bottom: .55rem; color: var(--text-muted); font-family: var(--font-mono); font-size: .68rem; letter-spacing: .08em; text-transform: uppercase; }
  h2 { margin: 0; font-family: var(--font-serif); font-size: 1.45rem; font-weight: 600; letter-spacing: -.02em; }
  p { margin: .45rem 0 0; color: var(--text-muted); font-size: .9rem; line-height: 1.5; }
  .actions { display: flex; align-items: center; gap: .4rem; margin-top: 1.15rem; }
  .actions span { flex: 1; }
  button { min-height: 2rem; padding: .4rem .7rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-card); color: var(--text); font: inherit; font-size: .78rem; cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-wash); color: var(--accent); }
  button:disabled { cursor: default; opacity: .42; }
  button.skip { padding-inline: 0; border-color: transparent; color: var(--text-muted); }
  button.skip:hover { border-color: transparent; background: transparent; color: var(--text); }
  button.primary { border-color: var(--accent); background: var(--accent); color: var(--text-on-accent); font-weight: 700; }
  button.primary:hover { background: var(--accent-strong); color: var(--text-on-accent); }
  @media (prefers-reduced-motion: reduce) { .spotlight, .tour-card { transition: none; } }
</style>
