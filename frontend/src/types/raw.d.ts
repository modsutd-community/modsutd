// Vite serves any file as a string with ?raw. Declared here because the
// templates live outside src/ and TypeScript has no idea what a ?raw import is.
declare module '*.md?raw' {
  const content: string;
  export default content;
}

// The mod-code pattern is duplicated into the relays and into fold_slots.py,
// which cannot import from the app. modCode.test.ts reads those files as text
// to prove the copies still agree.
declare module '*.js?raw' {
  const content: string;
  export default content;
}
declare module '*.py?raw' {
  const content: string;
  export default content;
}

// The PWA manifest and the document head, read as text so pwa.test.ts can
// prove the icons are declared rather than trusting that they are.
declare module '*.webmanifest?raw' {
  const content: string;
  export default content;
}
declare module '*.html?raw' {
  const content: string;
  export default content;
}
