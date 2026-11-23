import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import TalkTrack from "./TalkTrack";

afterEach(() => { cleanup(); window.location.hash = ""; });

const talk = [
  { id: "say-first", title: "Say it first", say: "The decision comes before the tool." },
  { id: "where", title: "Where it runs", say: "Each check has a place." },
];

describe("TalkTrack", () => {
  it("has exactly one primary button: the walkthrough start", () => {
    render(<TalkTrack talk={talk} />);
    const primary = screen.getAllByRole("button").filter((b) => b.classList.contains("primary"));
    expect(primary).toHaveLength(1);
    expect(primary[0]).toHaveTextContent("Start the walkthrough");
  });

  it("starts the walkthrough on the Evaluate tab, where the first talk step lives", () => {
    render(<TalkTrack talk={talk} />);
    fireEvent.click(screen.getByRole("button", { name: "Start the walkthrough" }));
    expect(window.location.hash).toBe("#evaluate");
  });

  it("still lists every talk step", () => {
    render(<TalkTrack talk={talk} />);
    expect(screen.getByTestId("talk-track").querySelectorAll("li")).toHaveLength(2);
  });
});
