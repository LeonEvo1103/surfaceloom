import type { DomLocator } from "./contracts.js";
import { BrowserAutomationError } from "./errors.js";
import type {
  PlaywrightLocatorLike,
  PlaywrightPageLike,
} from "./playwright-shapes.js";

export function defineDomLocator<const T extends DomLocator>(
  locator: T,
): Readonly<T> {
  requireText(locator.key, "locator key");
  switch (locator.kind) {
    case "role":
      requireText(locator.role, "role");
      if (locator.name !== undefined) requireText(locator.name, "role name");
      break;
    case "label":
    case "text":
      requireText(locator.text, `${locator.kind} text`);
      break;
    case "testId":
      requireText(locator.value, "test id");
      break;
    case "css":
      requireText(locator.selector, "CSS selector");
      break;
  }
  return Object.freeze({ ...locator }) as Readonly<T>;
}

export function resolveDomLocator(
  page: PlaywrightPageLike,
  input: DomLocator,
): PlaywrightLocatorLike {
  const locator = defineDomLocator(input);
  switch (locator.kind) {
    case "role": {
      const options = {
        ...(locator.name === undefined ? {} : { name: locator.name }),
        ...(locator.exact === undefined ? {} : { exact: locator.exact }),
      };
      return page.getByRole(locator.role, options);
    }
    case "label":
      return page.getByLabel(locator.text, exactOptions(locator.exact));
    case "text":
      return page.getByText(locator.text, exactOptions(locator.exact));
    case "testId":
      return page.getByTestId(locator.value);
    case "css":
      return page.locator(locator.selector);
  }
}

function exactOptions(exact: boolean | undefined): { readonly exact?: boolean } {
  return exact === undefined ? {} : { exact };
}

function requireText(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new BrowserAutomationError(
      "invalidArgument",
      `A DOM ${label} must not be empty.`,
    );
  }
}
