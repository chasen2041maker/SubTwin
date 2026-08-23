export interface AccessControlledStorageArea {
  setAccessLevel(options: {
    readonly accessLevel: 'TRUSTED_CONTEXTS';
  }): Promise<unknown> | unknown;
}

export async function restrictStorageToTrustedContexts(
  storage: AccessControlledStorageArea,
): Promise<void> {
  await storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}
