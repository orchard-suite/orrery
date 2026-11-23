# ADR-6001: Reports reach people through the desk, and stay snapshots

| | |
|---|---|
| **Decision Date** | 2026-11-18 |
| **Decision Maker** | Orrery maintainers |
| **Last Updated** | 2026-11-19 |

## Status

Accepted

## Audience

Anyone who changes how an edition is sent, or is asked to add live data to
reports.

## Purpose

Settles how editions are delivered, and where reports end and the
observability tool begins.

## Context

The hub keeps no mail code; every product sends through the notification
desk. Live series from metric and log stores already have their home.

## Decision

A publish writes a `report.published` activity row naming the recipients
who may see the report then. The notice forwarder sends it to the desk as
one event, with the edition's summary, headline numbers, and links, and
with the edition drawn for mail as the event's `page`; the desk decides how
each person hears and owns mail, and a letter it sends is that page. A
recipient is judged by the access rules as they stand, signed in or not:
someone who never visited is judged as a person arriving with no role. A report holds catalog
data and frozen snapshots for people. A live time series stays in the
observability tool; reports never become a metric explorer.

## What this means for the code

At most 20 recipients a report, what one desk event addresses. A wider
audience subscribes to the report's entity on the desk. The page is drawn
when the event is sent, from the kept edition, and is left out when it is
larger than the desk takes or the desk refuses it: the notice alone is
sent then. An edition's content is at rest in the desk's store from then
on, so the desk is trusted with what its recipients may see.

## Verification

`src/server/reports.test.ts` checks that only recipients who may see the
report are named, one who never signed in among them, the event the
forwarder sends with its page, and the notice alone after a refusal.

## Consequences

An estate without a desk keeps every edition and sends none.

## Related

Platform standard `send-every-product-s-notifications-through-one-delivery-serv`,
`forward-self-service-run-events-from-the-activity-log-idempo`,
`one-observability-stack-with-one-ingestion-door-and-opentele`.
