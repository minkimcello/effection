import type { Tag } from "html";
import type { Document, HTMLTemplateElement } from "dom";
import {
  defineConfig,
  setup,
  stringify,
  tw,
  virtual,
} from "https://esm.sh/@twind/core@1.1.3";
import presetTailwind from "https://esm.sh/@twind/preset-tailwind@1.1.4";

const config = defineConfig({
  //@ts-expect-error the tailwind preset types are wiggity whack.
  presets: [presetTailwind()],
});

export function twind(tag: Tag<string>, doc: Document): void {
  let sheet = virtual();

  setup(config, sheet);

  visit(tag);

  let css = stringify(sheet.target);

  let template = doc.createElement("template") as HTMLTemplateElement;
  template.innerHTML = `<style type="text/css">${css}</style>`;

  doc.head.appendChild(template.content.firstChild);
}

function visit(tag: Tag<string>): void {
  let { attrs: { class: classnames }, children } = tag;
  if (classnames) {
    tw(String(classnames));
  }
  for (let child of children) {
    if (typeof child !== "string") {
      visit(child);
    }
  }
}
