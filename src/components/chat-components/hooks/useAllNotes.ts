import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { TFile } from "obsidian";
import { notesAtom } from "@/state/vaultDataAtoms";
import { settingsStore } from "@/settings/model";

/**
 * Custom hook to get all available notes from the vault.
 * Includes canvas and PDF files; PDF parsing is local, so PDFs are available
 * to every user. Automatically updates when files are created, deleted, or
 * renamed. Notes are sorted by creation date in descending order (newest
 * first).
 *
 * Data is managed by the singleton VaultDataManager, which provides:
 * - Single set of vault event listeners (eliminates duplicates)
 * - Debounced updates (250ms) to batch rapid file operations
 * - Stable array references to prevent unnecessary re-renders
 *
 * @returns Array of TFile objects sorted by creation date (newest first)
 */
export function useAllNotes(): TFile[] {
  const allNotes = useAtomValue(notesAtom, { store: settingsStore });

  return useMemo(() => {
    // Return all files (md + PDFs + canvas) - create a copy to avoid mutating the atom
    const files = [...allNotes];

    // Sort by creation time in descending order (newest first)
    return files.sort((a, b) => b.stat.ctime - a.stat.ctime);
  }, [allNotes]);
}
