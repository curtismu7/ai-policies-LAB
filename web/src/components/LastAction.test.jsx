import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import LastAction from "./LastAction";

afterEach(() => { cleanup(); window.location.hash = ""; });

const last = {
  route: "/api/evaluate",
  ok: true,
  traceId: "0af7651916cd43dd8448eb211c80319c",
  hops: [{ n: 1, label: "Privilege check", request: { tool: "approve" }, response: { code: 200 } }],
};

describe("LastAction", () => {
  it("has exactly one primary button: Run next step", () => {
    render(<LastAction last={last} />);
    const primary = screen.getAllByRole("button").filter((b) => b.classList.contains("primary"));
    expect(primary).toHaveLength(1);
    expect(primary[0]).toHaveTextContent("Run next step");
  });

  it("runs the next step on the Evaluate tab", () => {
    window.location.hash = "#policies";
    render(<LastAction last={last} />);
    fireEvent.click(screen.getByRole("button", { name: "Run next step" }));
    expect(window.location.hash).toBe("#evaluate");
  });

  it("still shows the raw hops", () => {
    render(<LastAction last={last} />);
    expect(screen.getByTestId("hops")).toBeInTheDocument();
  });
});
