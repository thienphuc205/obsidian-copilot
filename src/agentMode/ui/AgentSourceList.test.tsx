import { AgentSourceList } from "@/agentMode/ui/AgentSourceList";
import type { SourceReference } from "@/context/sourceReferences";
import { logError } from "@/logger";
import { openSourceReference } from "@/utils/openSourceReference";
import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { App } from "obsidian";
import React from "react";

jest.mock("@/logger", () => ({ logError: jest.fn() }));
jest.mock("@/utils/openSourceReference", () => ({
  openSourceReference: jest.fn().mockResolvedValue(true),
}));

const mockOpenSourceReference = openSourceReference as jest.MockedFunction<
  typeof openSourceReference
>;
const mockLogError = logError as jest.MockedFunction<typeof logError>;

const app = {} as App;

function source(
  title: string,
  url: string,
  overrides: Partial<SourceReference> = {}
): SourceReference {
  return {
    title,
    path: url,
    score: 0,
    kind: "web",
    url,
    ...overrides,
  };
}

describe("AgentSourceList", () => {
  describe("AgentSourceList()", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockOpenSourceReference.mockResolvedValue(true);
    });

    it("returns null when no safe web source remains", () => {
      const { container } = render(
        <AgentSourceList
          app={app}
          sources={[
            source("Local note", "notes/research.md", { kind: "vault", url: undefined }),
            source("Unsafe URL", "javascript:alert(1)"),
            source("Private file", "file:///tmp/private.pdf"),
            source("Local service", "http://localhost/private"),
            source("Private network", "http://192.168.1.10/private"),
          ]}
        />
      );

      expect(container.firstChild).toBeNull();
    });

    it("deduplicates canonical URLs in input order and caps the visible list at ten sources", () => {
      const sources = [
        source("First result", "https://Example.com/article/?b=2&a=1#overview"),
        source("Duplicate result", "https://example.com/article?a=1&b=2"),
        ...Array.from({ length: 10 }, (_, index) =>
          source(`Result ${index + 1}`, `https://example.com/result-${index + 1}`)
        ),
      ];

      render(<AgentSourceList app={app} sources={sources} />);

      expect(screen.getAllByRole("link")).toHaveLength(10);
      expect(screen.getByRole("link", { name: "Open source: First result" })).toBeTruthy();
      expect(screen.queryByText("Duplicate result")).toBeNull();
      expect(screen.getByText("Result 9")).toBeTruthy();
      expect(screen.queryByText("Result 10")).toBeNull();
    });

    it("renders compact accessible links without exposing snippets, explanations, or raw URLs", () => {
      const url = "https://example.com/research";

      render(
        <AgentSourceList
          app={app}
          sources={[
            source("Research paper", url, {
              snippet: "Private excerpt that should stay out of the source rail",
              explanation: { secret: "arbitrary ranking data" },
            }),
          ]}
        />
      );

      expect(screen.getByText("Sources")).toBeTruthy();
      const link = screen.getByRole("link", { name: "Open source: Research paper" });
      expect(link.getAttribute("href")).toBe(url);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
      expect(link.textContent).toBe("Research paper");
      expect(screen.queryByText(/Private excerpt|arbitrary ranking data|example\.com/)).toBeNull();
    });

    it("prevents default bubbling and routes clicks through the source opener", async () => {
      const parentClick = jest.fn();
      const citation = source("Open research", "https://example.com/research");
      render(
        <div onClick={parentClick}>
          <AgentSourceList app={app} sources={[citation]} />
        </div>
      );

      const link = screen.getByRole("link", { name: "Open source: Open research" });
      const event = createEvent.click(link);
      fireEvent(link, event);

      expect(event.defaultPrevented).toBe(true);
      expect(parentClick).not.toHaveBeenCalled();
      expect(mockOpenSourceReference).toHaveBeenCalledWith(app, citation);

      const failure = new Error("open failed");
      mockOpenSourceReference.mockRejectedValueOnce(failure);
      fireEvent.click(link);
      await waitFor(() => expect(mockLogError).toHaveBeenCalledWith(failure));
    });

    it("ignores unsafe sources while retaining safe web citations", () => {
      render(
        <AgentSourceList
          app={app}
          sources={[
            source("Safe citation", "https://example.com/safe"),
            source("Vault note", "Research/paper.md", { kind: "vault", url: undefined }),
            source("Script payload", "javascript:alert(1)"),
            source("Credential URL", "https://user:pass@example.com/private"),
            source("Local URL", "http://127.0.0.1/private"),
          ]}
        />
      );

      expect(screen.getAllByRole("link")).toHaveLength(1);
      expect(screen.getByRole("link", { name: "Open source: Safe citation" })).toBeTruthy();
      expect(screen.queryByText("Vault note")).toBeNull();
      expect(screen.queryByText("Script payload")).toBeNull();
      expect(screen.queryByText("Credential URL")).toBeNull();
    });
  });
});
