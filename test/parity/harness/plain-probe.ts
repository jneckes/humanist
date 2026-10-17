// Slide detection for the plain render (the exit gate's "same Electron's plain render of the original file",
// docs/PHASE1-PLAN.md): the plain window has no preload, so the harness runs this script in an isolated world
// of it (bundled as an IIFE by harness/bundle.mjs) to know which slide is showing, with the very detection the
// render agent uses (9.4, @blueline/core/slides). It only reads the DOM, as the agent does; the page's own
// world never sees it. reveal.js's width and height come from the caller, who reads Reveal.getConfig() in the
// page's world, as the agent does.

import { currentSlide, detectSlides, type SlideModel } from '@blueline/core/slides';

interface PlainProbe {
  detect(revealConfig: { width: number; height: number } | null): { kind: string; count: number; current: number; navKind: string; designSize: { w: number; h: number } };
  current(): number;
}

let model: SlideModel | null = null;

const probe: PlainProbe = {
  detect(revealConfig) {
    model = detectSlides(document, window, { revealConfig, hashFormat: null, host: null });
    return { kind: model.kind, count: model.count, current: model.current, navKind: model.navKind, designSize: { ...model.designSize } };
  },
  current() {
    if (!model) probe.detect(null);
    const cur = currentSlide(model!, window);
    model!.current = cur;
    return cur;
  },
};

(globalThis as unknown as { __blParityProbe: PlainProbe }).__blParityProbe = probe;
