import type { UserProfile } from "@mindfultech/shared";
import { useMemo, useState } from "react";
import { normalizeSearch } from "../lib/emoji";
import { Avatar } from "./Avatar";
import { CheckIcon, ChevronRightIcon, SearchIcon } from "./icons";

interface UserPickerProps {
  users: UserProfile[];
  selected: string[];
  onChange: (userIds: string[]) => void;
  /** Already members: shown checked and locked. */
  locked?: string[];
  /** `single`: picking a person calls `onChange([userId])` right away, no checkboxes. */
  mode?: "multi" | "single";
}

/** Searchable multi-select over the user directory. */
export function UserPicker({
  users,
  selected,
  onChange,
  locked = [],
  mode = "multi",
}: Readonly<UserPickerProps>) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const q = normalizeSearch(query);
    return users.filter((u) => !q || normalizeSearch(`${u.displayName} ${u.email}`).includes(q));
  }, [users, query]);

  const toggle = (userId: string) => {
    if (mode === "single") return onChange([userId]);
    onChange(
      selected.includes(userId) ? selected.filter((id) => id !== userId) : [...selected, userId],
    );
  };

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30">
        <SearchIcon className="shrink-0 text-ink-secondary" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people…"
          aria-label="Search people"
          className="w-full bg-transparent py-2 text-sm text-ink placeholder:text-ink-secondary focus:outline-none"
        />
      </label>
      <ul
        className="max-h-56 overflow-y-auto rounded-lg border border-line"
        role="listbox"
        aria-multiselectable={mode === "multi"}
      >
        {visible.map((u) => {
          const isLocked = locked.includes(u.userId);
          const checked = isLocked || selected.includes(u.userId);
          return (
            <li key={u.userId} role="option" aria-selected={checked}>
              <button
                type="button"
                disabled={isLocked}
                onClick={() => toggle(u.userId)}
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-hover disabled:cursor-default disabled:hover:bg-transparent"
              >
                <Avatar name={u.displayName} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">
                    {u.displayName}
                  </span>
                  <span className="block truncate text-xs text-ink-secondary">
                    {isLocked ? "Already a member" : u.email}
                  </span>
                </span>
                {mode === "multi" ? (
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded border ${
                      checked ? "border-primary bg-primary text-on-accent" : "border-line"
                    } ${isLocked ? "opacity-50" : ""}`}
                  >
                    {checked && <CheckIcon className="text-xs" />}
                  </span>
                ) : (
                  <ChevronRightIcon className="text-ink-secondary" />
                )}
              </button>
            </li>
          );
        })}
        {visible.length === 0 && (
          <li className="px-3 py-3 text-sm text-ink-secondary">
            {users.length === 0 ? "Nobody else has signed in yet." : "No results."}
          </li>
        )}
      </ul>
    </div>
  );
}
