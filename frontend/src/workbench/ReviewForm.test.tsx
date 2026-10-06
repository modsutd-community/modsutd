// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReviewForm } from "./ReviewForm";
import type { Mod } from "@/types";

const mockMod: Mod = {
    code: "50.040",
    name: "Natural Language Processing",
    description: "NLP course description",
    department: "Computer Science and Design",
    term: "7",
    credits: 12,
    pillar: "CSD",
    schedules: [],
};

describe("ReviewForm prefill and editing", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it("does not revert user edits to prefilled fields when parent re-renders", () => {
        const { rerender } = render(
            <ReviewForm
                mod={mockMod}
                prefillVals={{ "Best part": "Initial Best" }}
            />,
        );

        const textarea = screen.getByLabelText("Best part") as HTMLTextAreaElement;
        expect(textarea.value).toBe("Initial Best");

        // User edits the field
        fireEvent.change(textarea, { target: { value: "User Custom Edit" } });
        expect(textarea.value).toBe("User Custom Edit");

        // Parent re-renders passing a new prefillVals object with the original prefill value
        rerender(
            <ReviewForm
                mod={mockMod}
                prefillVals={{ "Best part": "Initial Best" }}
            />,
        );

        // Crucial test: user edit must be preserved, not overwritten by re-render
        expect(textarea.value).toBe("User Custom Edit");
    });

    it("preserves user edits across unmount and remount rather than reverting to old prefill", () => {
        const { unmount } = render(
            <ReviewForm
                mod={mockMod}
                prefillVals={{ "Best part": "Initial Best" }}
            />,
        );

        const textarea = screen.getByLabelText("Best part") as HTMLTextAreaElement;
        fireEvent.change(textarea, { target: { value: "User Custom Edit" } });

        // User clicks away (panel unmounts)
        unmount();

        // User opens panel again
        render(<ReviewForm mod={mockMod} />);

        const remountedTextarea = screen.getByLabelText("Best part") as HTMLTextAreaElement;
        expect(remountedTextarea.value).toBe("User Custom Edit");
    });

    it("preserves user edits across remount even if parent re-passes old prefillVals prop", () => {
        const { unmount } = render(
            <ReviewForm
                mod={mockMod}
                prefillVals={{ "Best part": "Initial Best" }}
            />,
        );

        const textarea = screen.getByLabelText("Best part") as HTMLTextAreaElement;
        fireEvent.change(textarea, { target: { value: "User Custom Edit" } });

        unmount();

        // When user opens panel again in Workbench where sharePrefill was not cleared
        render(
            <ReviewForm
                mod={mockMod}
                prefillVals={{ "Best part": "Initial Best" }}
            />,
        );

        const remountedTextarea = screen.getByLabelText("Best part") as HTMLTextAreaElement;
        expect(remountedTextarea.value).toBe("User Custom Edit");
    });

    it("does not revert user edits to prefilled text when parent re-renders or remounts", () => {
        const { rerender, unmount } = render(
            <ReviewForm
                mod={mockMod}
                prefillText="Initial Text"
            />,
        );

        const textarea = screen.getByLabelText("review body") as HTMLTextAreaElement;
        expect(textarea.value).toBe("Initial Text");

        fireEvent.change(textarea, { target: { value: "User Custom Body Text" } });
        expect(textarea.value).toBe("User Custom Body Text");

        rerender(
            <ReviewForm
                mod={mockMod}
                prefillText="Initial Text"
            />,
        );
        expect(textarea.value).toBe("User Custom Body Text");

        unmount();

        render(
            <ReviewForm
                mod={mockMod}
                prefillText="Initial Text"
            />,
        );
        const remounted = screen.getByLabelText("review body") as HTMLTextAreaElement;
        expect(remounted.value).toBe("User Custom Body Text");
    });
});
