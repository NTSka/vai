# Identity Domain Types

This document captures user identity and authentication types.

Authorization, organization membership, and roles are documented in separate
domains.

## Principles

- A `User` is a person/account in the system, not owned by a single
  organization.
- Authorization credentials are separate from the user profile.
- A user may have multiple credentials in the future, for example password auth,
  SSO, LDAP, or OAuth.

## Identifiers

```ts
type UserID = string;
```

## User

`User` stores the account profile. Organization-specific role, position, and
access data must not be stored here.

```ts
interface User {
  id: UserID;

  email: string;
  fullName: string;

  status: UserStatus;

  createdAt: Date;
  updatedAt: Date;
}

type UserStatus =
  | "invited"
  | "active"
  | "disabled";
```

## UserCredential

`UserCredential` describes a way for a user to sign in.

```ts
interface UserCredential {
  userId: UserID;

  authProvider: AuthProvider;

  login: string;

  passwordHash?: string;

  isPrimary: boolean;

  lastLoginAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

type AuthProvider =
  | "password"
  | "sso"
  | "ldap"
  | "oauth";
```

## Open Questions

- Should `UserCredential` support multiple credentials per user from day one?
- Should invited users be represented as `User` records immediately, or should
  invitation state live in a separate type?
