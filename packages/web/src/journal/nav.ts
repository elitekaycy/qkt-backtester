import { create } from "zustand";

/** Cross-view hand-off inside the journal: "open the calendar on this month". Not persisted. */
interface Nav { month: string | null; setMonth(m: string | null): void }
export const useJournalNav = create<Nav>((set) => ({ month: null, setMonth: (month) => set({ month }) }));
