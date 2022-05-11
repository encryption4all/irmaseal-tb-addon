# PostGuard addon for Thunderbird

The PostGuard addon utilizes E2E identity-based encryption to secure
e-mails. This allows for easy-to-use encryption without the burden of key
management.

Anyone can encrypt without prior setup using this system. For decryption, a
user requests a decryption key from trusted third party. To do so, the user
must authenticate using [IRMA](https://irma.app/), a privacy-friendly
decentralized identity platform based on the Idemix protocol. Any combination of
attributes in the IRMA ecosystem can be used to encrypt e-mails, which allows for
detailed access control over the e-mail's content.

Examples include:

-   Sending e-mails to health care professionals, using their professional registration number.
-   Sending e-mails to people that can prove that they have a certain role within an organisation.
-   Sending e-mails to people that can prove that they are over 18.
-   Sending e-mails to people that can prove that they live within a country, city, postal code or street.
-   Or any combination of the previous examples.

For more information, see [our website](https://postguard.eu/) and [our Github
organisation](https://github.com/encryption4all/irmaseal).

## Prerequisites

Node and a package manager like `yarn`, or alternatively `npm`, are required to
build the addon. Building the addon was tested on:

-   node `v17.9.0`,
-   yarn `v1.22.18`.

## Building

Install the dependencies and build the extension using:

```
yarn
yarn build
```

## WebAssembly

Postguard's [cryptographic
core](https://github.com/encryption4all/irmaseal/tree/main/irmaseal-core) is
implemented in Rust, which is compiled down to WebAssembly in
[irmaseal-wasm-bindings](https://github.com/encryption4all/irmaseal/tree/main/irmaseal-wasm-bindings)
using `wasm-pack`. For this purpose, we require a `script-source 'unsafe-eval'`
directive in the Content Security Policy (CSP). Hopefully, this can soon be
replaced with `unsafe-wasm-eval` in a newer version of Firefox/Thunderbird.

## Experiments

The addon currently uses four experiments:

-   the `pg4tb` experiment, which registers encryption and decryption handlers for the `application/postguard` parts. This is based on older technology, and it might soon not be neccessary, but allows for more finegrained control over the encryption/decryption process. It seems to work well in current and older versions. Before bumping the `strict_max_version` in the manifest to a new major release version, this should of course first be tested.
-   the [notifyTools](https://github.com/thundernest/addon-developer-support/tree/master/auxiliary-apis/NotifyTools) experiment. Used for communication between the background script and the encrypted/decryption handlers registerd in the `pg4tb` experiment.
-   the [notificationbar API](https://github.com/jobisoft/notificationbar-API) to show warning/error notifications.
-   the `switchbar` experiment, which is a modification of the notificationbar API that implements a switchable toolbar inside the compose window. This experiment uses `innerHTML` to adjust the bar. This can probably be avoided, but the input is not user input, rather developer input. For now, no plans are made to publish the experiment, since it is tailored specific to our UX needs.

## Self-distribution & updates

To self-distribute (and update the addon) make sure that the following is present in the manifest:

```
"browser_specific_settings": {
    "gecko": {
        "update_url": "<UPDATE_URL>/updates.json"
    }
}
```

At this URL a file (see, `dist/updates.json`) should be hosted. This file
contains updates consisting of a version, a download URL for this specific
version and optionally, version restrictions.

```json
{
    "addons": {
        "pg4tb@e4a.org": {
            "updates": [
                {
                    "version": "0.1",
                    "update_link": "<DOWNLOAD_URL>/postguard-tb-addon-0.1.xpi"
                }
            ]
        }
    }
}
```

## Funding

PostGuard is being developed by a multidisciplinary (cyber security, UX) team from
[iHub](https://ihub.ru.nl/) at Radboud University, in the Netherlands, funded
by NWO.
