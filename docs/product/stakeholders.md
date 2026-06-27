# Stakeholders and Actors

This document captures initial stakeholders and system actors.

## Human Actors

### Organization User

A user working inside an organization. Can upload documents, view available
documents, and use configured capabilities according to assigned permissions.

### Organization Owner

A user responsible for organization administration. Can manage organization
settings, users, and future custom roles.

### Platform Administrator

A system-level operator responsible for platform administration, support, and
operational configuration.

### Reviewer or Expert

A future role for users who validate extracted data, review comparison results,
or resolve uncertain processing outcomes.

## System Actors

### Integration Client

An external system that can send documents or consume results through an API or
future integration channel.

### Processing Worker

A system component that performs technical document processing, type detection,
code extraction, data extraction, or future semantic processing.

### Capability Module

A configurable business module that consumes normalized document data and
produces business results such as comparisons, checks, reports, or review items.
