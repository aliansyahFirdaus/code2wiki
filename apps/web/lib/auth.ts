export type CurrentUser = {
  id: string;
  name?: string;
};

export async function getCurrentUser(): Promise<CurrentUser | null> {
  return null;
}
