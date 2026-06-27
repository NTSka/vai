export type AuthenticatedUser = {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
};

export type AuthenticatedOrganization = {
  readonly id: string;
  readonly name: string;
  readonly membershipId: string;
  readonly roleIds: readonly string[];
  readonly permissionKeys: readonly string[];
};

export type AuthSession = {
  readonly user: AuthenticatedUser;
  readonly organizations: readonly AuthenticatedOrganization[];
};

export type TokenSession = {
  readonly userId: string;
  readonly sessionId: string;
};

export type AuthService = {
  login(input: {
    readonly login: string;
    readonly password: string;
  }): Promise<AuthSession | undefined>;
  loadSession(input: { readonly userId: string }): Promise<AuthSession | undefined>;
};
