import { api } from "@/lib/api";

export interface InboxItem {
  id: string;
  store_id: string | null;
  store_name: string | null;
  event: string;
  title: string;
  body: string;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

export interface CatalogEntry {
  event: string;
  label: string;
  description: string;
  channels: string[];
  optional: boolean;
}

export interface Preference {
  event: string;
  channel: string;
  storeId: string | null;
  enabled: boolean;
}

export function loadInbox(unreadOnly = false): Promise<InboxItem[]> {
  return api<InboxItem[]>(`/me/notifications/inbox${unreadOnly ? "?unread=true" : ""}`, {
    revalidate: false,
  });
}

/**
 * The number on the badge.
 *
 * Returns zero rather than throwing when nobody is signed in: the shell renders
 * on pages a signed-out visitor can reach, and a header should not be able to
 * take a page down.
 */
export async function unreadCount(): Promise<number> {
  try {
    const { count } = await api<{ count: number }>("/me/notifications/unread-count", {
      revalidate: false,
    });
    return count;
  } catch {
    return 0;
  }
}

export function loadCatalog(): Promise<CatalogEntry[]> {
  return api<CatalogEntry[]>("/me/notifications/catalog", { revalidate: false });
}

export function loadPreferences(): Promise<Preference[]> {
  return api<Preference[]>("/me/notifications", { revalidate: false });
}
