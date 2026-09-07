// Vite serves any file as a string with ?raw. Declared here because the
// templates live outside src/ and TypeScript has no idea what a ?raw import is.
declare module '*.md?raw' {
  const content: string;
  export default content;
}
