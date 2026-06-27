# Organizations Domain Types

This document captures organization and membership types.

User identity is documented separately. Roles and permission definitions are
documented in the access-control domain.

## Principles

- An `Organization` owns data and provides the business context for access.
- Organization kind/type is intentionally omitted for now and will be introduced
  later when the taxonomy is clear.
- A user belongs to an organization through `OrganizationMember`.
- `OrganizationMember` may reference roles, but role definitions live in the
  access-control domain.

## Identifiers

```ts
type UserID = string;
type OrganizationID = string;
type OrganizationMemberID = string;
type RoleID = string;
```

## Organization

```ts
interface Organization {
  id: OrganizationID;

  name: string;

  status: OrganizationStatus;

  createdAt: Date;
  updatedAt: Date;
}

type OrganizationStatus =
  | "active"
  | "disabled";
```

## OrganizationMember

`OrganizationMember` connects a user to an organization and assigns roles in
that organization.

```ts
interface OrganizationMember {
  id: OrganizationMemberID;

  organizationId: OrganizationID;
  userId: UserID;

  roleIds: RoleID[];

  status: OrganizationMemberStatus;

  invitedBy?: UserID;

  createdAt: Date;
  updatedAt: Date;
}

type OrganizationMemberStatus =
  | "invited"
  | "active"
  | "disabled";
```

## Open Questions

- Should organization ownership be represented as a role assignment or as a
  dedicated invariant on organization creation?
- Should membership invitation be modeled here or in the identity domain?
