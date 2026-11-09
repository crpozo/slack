// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstallBanner, InstallGuideModal } from "./InstallGuide";

// Phase 56: keeping MindfulTech as an app on the Home Screen.

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function device(userAgent: string, standalone = false) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: standalone && query.includes("standalone"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    })),
  );
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("installing the app", () => {
  it("shows an iPhone the Share → Add to Home Screen steps first; other devices a tap away", () => {
    device(IPHONE);
    render(<InstallGuideModal onClose={() => {}} />);
    expect(screen.getByRole("tab", { name: "iPhone / iPad" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    const steps = screen.getByRole("tabpanel").textContent ?? "";
    expect(steps).toContain("Safari");
    expect(steps).toContain("Compartir");
    expect(steps).toContain("Agregar a inicio");
    fireEvent.click(screen.getByRole("tab", { name: "Android" }));
    expect(screen.getByRole("tabpanel").textContent).toContain("Instalar app");
  });

  it("suggests it on an iPhone in Safari until dismissed, never once installed or elsewhere", () => {
    device(IPHONE);
    render(<InstallBanner />);
    expect(screen.getByText("Instala MindfulTech como app")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ver cómo" }));
    expect(document.querySelector("[data-install-guide]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "No, gracias" }));
    cleanup();
    render(<InstallBanner />);
    expect(screen.queryByText("Instala MindfulTech como app")).toBeNull();

    localStorage.clear();
    cleanup();
    device(IPHONE, true); // opened from the Home Screen
    render(<InstallBanner />);
    expect(screen.queryByText("Instala MindfulTech como app")).toBeNull();

    cleanup();
    device("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0");
    render(<InstallBanner />);
    expect(screen.queryByText("Instala MindfulTech como app")).toBeNull();
  });
});
