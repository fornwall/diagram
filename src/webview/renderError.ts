// The message of a diagram that failed to render, with the places in the source that it names
// linked to them.

/** Where an error is, which its message names as "(line 3, column 5)", or as "on line 3". */
const placeOf = (text: string) =>
  /(?<=\()line (\d+), column (\d+)(?=\))/.exec(text) ??
  /(?<=\bon )line (\d+)(?:, column (\d+))?/.exec(text);

/**
 * Shows the message in the element, as "This diagram failed to render: " and the message. Its first
 * line, and those after it that name places of further problems, as a Mermaid error does on
 * several lines, name their places as links that `reveal` the place in the source, unless the
 * source editor holds edits of another diagram, where there is no place to show. Details after
 * them, like an excerpt of the source with a caret, need a fixed font.
 */
export function showRenderError(
  element: HTMLElement,
  noun: string,
  message: string,
  reveal: ((line: number, column: number | undefined) => void) | undefined,
): void {
  const lines = message.split("\n");
  let problems = 1;
  while (problems < lines.length && placeOf(lines[problems] as string)) problems++;
  const details = lines.slice(problems);
  element.textContent = `This ${noun} failed to render: `;
  for (const [i, problem] of lines.slice(0, problems).entries()) {
    if (i > 0) element.append(document.createElement("br"));
    const place = reveal && placeOf(problem);
    if (!place) {
      element.append(problem);
      continue;
    }
    const [text, line, column] = place;
    const link = document.createElement("button");
    link.className = "link";
    link.textContent = text;
    link.title = "Show this place in the source";
    link.addEventListener("click", () =>
      reveal(Number(line), column === undefined ? undefined : Number(column)),
    );
    // With the punctuation around it, such as its parentheses, which a line would break off.
    const end = place.index + text.length;
    const start = problem.slice(0, place.index).search(/\S*$/);
    const stop = end + problem.slice(end).search(/\s|$/);
    const glued = document.createElement("span");
    glued.className = "place";
    glued.append(problem.slice(start, place.index), link, problem.slice(end, stop));
    element.append(problem.slice(0, start), glued, problem.slice(stop));
  }
  if (details.length > 0) {
    const pre = document.createElement("pre");
    pre.textContent = details.join("\n");
    element.append(pre);
  }
  element.hidden = false;
}
