// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewBoundary } from "./ViewBoundary";

function Boom({ fail }: Readonly<{ fail: boolean }>) {
  if (fail) throw new Error("render failed");
  return <p>Fine</p>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ViewBoundary", () => {
  it("keeps a view's render error inside the view, with a way out; another view tries again", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <MemoryRouter>
        <ViewBoundary resetKey="/app/ch_a">
          <Boom fail />
        </ViewBoundary>
      </MemoryRouter>,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/Something went wrong/);
    expect(screen.getByRole("link", { name: "Go to #general" })).toBeTruthy();

    rerender(
      <MemoryRouter>
        <ViewBoundary resetKey="/app/ch_b">
          <Boom fail={false} />
        </ViewBoundary>
      </MemoryRouter>,
    );
    expect(screen.getByText("Fine")).toBeTruthy();
  });
});
