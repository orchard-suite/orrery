# ADR-5008: A person is drawn by their own picture

| | |
|---|---|
| **Decision Date** | 2026-11-20 |
| **Decision Maker** | Orrery maintainers |
| **Last Updated** | 2026-11-20 |

## Status

Accepted

## Audience

Anyone who changes how a person entity's icon is worked out, how a picture is stored or served, or what the icon picker offers.

## Purpose

Settles where a person's face comes from, who may change it, and how it stays cheap on a grid of many people.

## Context

People are what the catalog assigns things to: owners, members of teams,
approvers. An identity provider holds most people's photos, and a face is
found faster than a name. An entity's icon is a value with layers, and
a source's value gives way to a person's hand edit only where the field is
sticky; an owner's edit never stands over what a source says. A photo is
also not an icon: an icon is a picture anyone may give anything, and a face
must stay on its own person.

## Decision

A picture is kept by the address a person signs in with, in the `pictures`
table, apart from the entity's values and apart from the custom icons. It
holds two things:

- **The photo**, put by a source, in two sizes: a 64 pixel square JPEG of at
  most 16 KiB for every place a person is drawn beside other things, and a
  256 pixel one of at most 64 KiB for their own page. The source makes both;
  the hub checks their type, size, and bytes and never decodes one. A photo
  is named `photo:<sha256>` by its bytes and served at
  `/v1/photos/<sha256>/<size>`, kept by the browser for good.
- **The pick**, an icon of the set or a custom icon the person chose in its
  place. It is theirs alone, set at `/v1/mine/picture` like a pin, and shown
  to everyone. No source's photo moves it.

The person entity the person setting answers to the address shows the
pick, else the photo, else its own icon. That is laid over the entity where
it is read and stored as its derived icon, so whatever draws it beside
another thing draws the face too.

No picker offers a photo. A person picking their own picture is offered
their own photo first; nobody is offered anyone else's. An icon written as
a value that names a photo is no icon.

## What this means for the code

- `pictures.ts` is the store: the checks, who may put or remove a photo
  (any source, and only the one that put it removes it), the pick, and the
  queueing of the person entity a change moves.
- `read.ts` lays the picture on as it builds a person entity, and `hydrate`
  lays it on again, so a picture that came or went since the row was
  derived shows at once.
- `annotatePeople` and `peopleShown` in `visibility.ts` put each person's
  picture on the relations, `user` values, and users a reader is shown.
- The web app draws a photo round and small everywhere, large only on the
  person's page.

## Verification

`src/server/pictures.test.ts` holds the checks, the same bytes again, the
serving, the face beside what names a person, the pick and its reset, and
that nobody may pick a photo.

## Consequences

A grid of fifty people costs fifty small images once, about 3 KiB each,
then nothing. A person sees their face without anyone opening an edit rule
for them. Changing someone else's picture is not possible, even for an
admin; an admin changes the icon of a person who has neither photo nor pick.

## Related

- [ADR-5007](5007-stars-order-the-catalog-never-a-query.md): another thing that is a person's own.
