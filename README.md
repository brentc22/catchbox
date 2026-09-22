<div align="center">

# catchbox

**A disposable inbox for developers.** Grab an address, catch the mail, pull out the link or the code — without leaving your terminal.

![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933?style=flat-square&logo=node.js&logoColor=white)
![No dependencies](https://img.shields.io/badge/dependencies-none-6366f1?style=flat-square)
![MIT](https://img.shields.io/badge/license-MIT-black?style=flat-square)

<img src="docs/inbox-dark.png" alt="The catchbox inbox, showing a verification email with the code and sign-in link pulled out above the message" width="880">

</div>

## Why

Testing a signup flow means reading an email you don't care about, to copy one thing out of it.
catchbox skips the reading: it pulls the **one-time code** and the **action link** out of the
message and hands you those.

```sh
catchbox                  # test-k3f9qz1p@uberip.com  (copied)
# …paste it into your signup form…
catchbox code --wait      # 482910  (copied)
```

That is the whole loop. No browser, no account, no waiting on a shared mailbox someone else
is also testing against.

## Install

```sh
npm install -g github:brentc22/catchbox
```

Or clone it and link:

```sh
git clone https://github.com/brentc22/catchbox.git
cd catchbox && npm link
```

Node 18 or newer. No dependencies — it talks to [mail.tm](https://mail.tm) over `fetch` and
nothing else.

The binary installs under both `catchbox` and `testmail`, so older scripts and shell aliases
keep working after the rename.

## The inbox

```sh
catchbox ui
```

A local inbox on `http://localhost:7337`. New mail appears by itself — no refreshing — and
every message leads with what you actually need:

- The **code**, in one click's reach
- The **action link**, with tracking pixels and unsubscribe footers filtered out of the way
- **HTML** rendered in a sandboxed frame, so you can check how the template really looks
- **Headers** with a deliverability read: DKIM signature, domain alignment, plain-text part,
  `List-Unsubscribe`

<div align="center">
<img src="docs/inbox-light.png" alt="The same inbox in light theme, showing the rendered HTML of the email" width="880">
</div>

Light and dark, keyboard-driven (`j`/`k` to move, `c` to copy the code, `o` to open the link,
`/` to filter), and usable on a phone.

Want to look around first? `TESTMAIL_DEMO=1 catchbox ui` serves a fixed example inbox and
never touches the network.

## Commands

```
catchbox                  show the current address and copy it
catchbox new              new address (deletes the old one), copied
catchbox ui [port]        open the inbox in your browser (default 7337)

Catching mail
  catchbox wait [sec]     block until mail arrives, then print it
  catchbox list           list the inbox
  catchbox show [n]       print message n (0 = newest)
  catchbox open [n]       render message n as HTML in your browser

Pulling things out
  catchbox code           the one-time code, copied to your clipboard
  catchbox link --open    the most likely action link, opened in your browser
  catchbox headers [n]    SPF / DKIM / DMARC and what would hurt deliverability
  catchbox eml [n]        save the raw .eml

Cleaning up
  catchbox rm [n]         delete message n, or the whole account if n is omitted
```

Flags: `--wait [sec]`, `--grace <sec>`, `--json`, `--all`, `--open`, `--out <file>`.

## In scripts and CI

Every reading command takes `--json`:

```sh
TOKEN=$(catchbox wait 60 --json | jq -r '.links[0]')
curl -sS "$TOKEN"
```

`--grace` exists because the obvious script always loses a race: you click something in your
app, *then* start waiting, and the mail has already arrived. By default anything from the last
90 seconds still counts.

## Checking deliverability

```sh
$ catchbox headers
Subject:      Welcome to Acme
From domain:  acme.dev

No Authentication-Results header — this inbox does not verify on receipt.
Checking domain alignment instead, which is what DMARC evaluates:

DKIM signature: acme.dev (selector sel1)
DKIM aligned:   yes
SPF aligned:    NO  (bounces to mail.sendgrid.net — normal via an ESP, DKIM has to carry DMARC)

Plain text part: NO  — HTML-only mail is downranked by iCloud and Outlook
List-Unsubscribe: none
```

A disposable inbox doesn't run SPF or DKIM checks on arrival, so there is no verdict to read.
What the headers still allow is the **alignment** check DMARC itself performs — whether the
signing domain and the bounce domain line up with the `From` domain. That is usually the answer
to "why did this land in spam", and you get it without setting up a real mailbox first.

## How it works

mail.tm provides the mailbox. catchbox keeps the account in `~/.config/testmail/account.json`,
mints a new token when the old one expires, and creates a fresh account when mail.tm drops
yours after a period of inactivity — so a command never fails just because you didn't use it
for a week.

It shares that account file with [`mailsy`](https://github.com/BalliAsghar/Mailsy), so both
tools always agree on which inbox is current.

## Limits

- **Public mailbox.** Anyone who guesses the address can read it. It is for testing, not for
  anything you mind other people seeing.
- **mail.tm expires idle accounts.** catchbox creates a new one for you, but the old messages
  are gone.
- **Receive only.** There is no way to send from these addresses.

## Development

```sh
node --test        # the extraction rules — codes, links, headers
```

The interesting part is [`src/extract.js`](src/extract.js): deciding which six-digit number in
an email is the code, and which of eleven URLs is the one you meant to click. Both are covered
by tests, because the failure mode is silent and confusing — a wrong code costs more than no
code, so it returns nothing rather than guessing.

## License

MIT
