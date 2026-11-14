/** Shows the not-found page, under the name of the app that serves it. */
export function mountNotFound(root: HTMLElement, appName: string): void {
  document.title = "Not found";
  const shell = document.createElement("div");
  shell.className = "app-shell";

  const header = document.createElement("header");
  header.className = "app-header";

  const titleGroup = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = appName;

  const title = document.createElement("h1");
  title.textContent = "Not found";

  titleGroup.append(eyebrow, title);
  header.append(titleGroup);

  const main = document.createElement("main");
  main.className = "surface";

  shell.append(header, main);
  root.innerHTML = "";
  root.append(shell);
}
