# ADR 0001 — Communications happen in the app

**Status:** accepted, 2026-08-04
**Supersedes:** the channel columns of [§5.9](../plan/05-user-roles-and-journeys.md)
**Affects:** notifications, delivery, inventory alerts, billing

## Decision

Business communication happens **inside the app**. Customers and staff learn
what they need from their own dashboard, not from an inbox somewhere else.

The plan's §5.9 catalogue specified a fan-out across email, web push and SMS
per event. That is not what this product is. Push needs FCM, SMS needs Twilio
and costs money per message, and both put the shop's relationship with its
customer inside somebody else's delivery pipeline. A local bakery telling a
regular their bread is ready does not need three vendors involved.

## What stays email, and why

Two categories cannot be in-app, and this is a limitation of the medium rather
than a preference:

- **Account access** — email verification, password reset, staff invitations.
  A password reset by definition reaches somebody who cannot sign in. An
  invitation goes to somebody who has no account yet. There is no in-app to
  put these in.
- **Billing grace-period warnings (dunning)** — kept as a backstop, narrowly.
  The entire point of dunning is reaching an owner who is *not* signing in:
  nothing looks broken while the shop keeps trading through its seven-day grace
  period, so an in-app warning is seen only by somebody who was going to look
  anyway. In-app now carries it too; the email remains for the case the in-app
  notice cannot cover.

Everything else — order status, delivery assignment, low stock — is in-app
only.

## Consequences

- The notification catalogue's channels become `IN_APP` for business events.
  `EMAIL` stays declared only where the paragraph above justifies it.
- An inbox table and an unread count become part of the shell, because a
  notification nobody can find is not a notification.
- Preferences still apply: in-app is less intrusive than email, but a person
  who does not want to hear about something should still be able to say so.
- Push and SMS are not deferred — they are **out of scope**. Nothing should be
  built to leave room for them.
