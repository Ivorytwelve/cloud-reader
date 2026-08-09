export interface CloudBookLink {
  cloudBookId: string;
  localBookId: number;
  title: string;
  linkedAt: number;
}

const LINKS_KEY = 'ttu-cloud-book-links-v1';

function readLinks(storage: Storage): CloudBookLink[] {
  try {
    const raw = storage.getItem(LINKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (value): value is CloudBookLink =>
        !!value &&
        typeof value === 'object' &&
        typeof (value as CloudBookLink).cloudBookId === 'string' &&
        Number.isInteger((value as CloudBookLink).localBookId) &&
        typeof (value as CloudBookLink).title === 'string'
    );
  } catch {
    return [];
  }
}

function writeLinks(links: CloudBookLink[], storage: Storage): void {
  storage.setItem(LINKS_KEY, JSON.stringify(links));
}

export function getCloudBookLinks(storage: Storage = localStorage): CloudBookLink[] {
  return readLinks(storage);
}

export function linkCloudBook(
  cloudBookId: string,
  localBookId: number,
  title: string,
  storage: Storage = localStorage
): CloudBookLink {
  const links = readLinks(storage).filter(
    (link) => link.cloudBookId !== cloudBookId && link.localBookId !== localBookId
  );
  const link: CloudBookLink = { cloudBookId, localBookId, title, linkedAt: Date.now() };
  links.push(link);
  writeLinks(links, storage);
  return link;
}

export function unlinkCloudBook(cloudBookId: string, storage: Storage = localStorage): void {
  writeLinks(
    readLinks(storage).filter((link) => link.cloudBookId !== cloudBookId),
    storage
  );
}

export function getCloudLinkByLocalBookId(
  localBookId: number,
  storage: Storage = localStorage
): CloudBookLink | undefined {
  return readLinks(storage).find((link) => link.localBookId === localBookId);
}

export function getCloudLinkByCloudBookId(
  cloudBookId: string,
  storage: Storage = localStorage
): CloudBookLink | undefined {
  return readLinks(storage).find((link) => link.cloudBookId === cloudBookId);
}
