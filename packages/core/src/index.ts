// Barrel for main-process and CLI code. Preloads and the shell import by subpath instead
// (`@blueline/core/<file>`), so parse5 and acorn never reach a renderer bundle.
export * from './types';
export * from './ipc';
export * from './capabilities';
export * from './text';
export * from './offset-table';
export * from './notes-block';
export * from './html-tables';
export * from './js-literals';
export * from './mapper-literals';
export * from './mapper';
export * from './served';
export * from './matcher';
export * from './edit-cleanup';
