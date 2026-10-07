<p align="center">
  <img src="build/icon.png" width="128" alt="Hojicha Launcher logo: a pixel-art cup of hojicha">
</p>

<h1 align="center">Hojicha Launcher</h1>

<p align="center">
  A small, open-source Minecraft: Java Edition launcher for Windows.
</p>

> **NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.**

![Hojicha Launcher showing an instance's mods, resource packs and shaders](docs/screenshot-mods.png)

## Features

- **Instances** — vanilla or Fabric, any version, each with its own mods and worlds
- **Installed** — mods, resource packs and shaders in one list; toggle or update in one click
- **Modrinth** — browse and install mods, packs, shaders and modpacks
- **Syncing** — share worlds, settings and packs between instances
- **Servers** — run a Paper, Purpur or Fabric server; friends join over the internet via [playit.gg](https://playit.gg) without port forwarding
- **Skins and capes** — change your skin and cape with a 3D preview; saved skins carry across accounts
- **Schematics** — view Litematica, WorldEdit and Axiom files (.litematic, .schem, .schematic, .bp) in 3D, grouped and sorted
- **Two themes** — dark **Hojicha** and light **Matcha**
- **Sign-in on Microsoft's website** — Hojicha never sees your password; tokens are stored encrypted on your PC

| Browse Modrinth | Online play |
| --- | --- |
| ![Modrinth browser with install buttons](docs/screenshot-browse.png) | ![A running server with its address and whitelist](docs/screenshot-server.png) |
| **New server** | **Accounts** |
| ![New server dialog with Paper, Purpur and Fabric](docs/screenshot-new-server.png) | ![Accounts dialog](docs/screenshot-accounts.png) |

![The light Matcha theme](docs/screenshot-matcha.png)

## Install

Download the installer from the [Releases](../../releases) page. Windows SmartScreen may warn on first run since the installer isn't code-signed — click **More info → Run anyway**. The launcher installs to `%LOCALAPPDATA%\Programs\Hojicha Launcher` by default and updates itself automatically.

To uninstall, run `uninstall.exe` in the launcher folder or use **Settings → Apps**. This deletes the entire folder, **including your instances and worlds**, so back up anything you want to keep first.

## Building from source

Requires [Node.js](https://nodejs.org/) 22+.

```
npm install
npm start          # run the launcher
npm run dist       # build the installer to dist\
```

If `npm start` reports that Electron failed to install, run `node node_modules/electron/install.js` once.  
If the build fails with `EXDEV` or `7za.exe ... ENOENT`, use a short cache path:

```
$env:ELECTRON_BUILDER_CACHE = "$env:TEMP\eb-cache"; npm run dist
```

## Known limitations

- Windows only
- No Forge, NeoForge or Quilt
- Synced `options.txt` is shared as-is, which can mix up settings across very different versions
- Synced worlds upgrade when opened in newer versions and may not open in older ones afterwards
- The schematics view shows vanilla blocks only; mod blocks appear as missing-texture cubes
- Online play uses playit.gg's address; custom domains aren't supported

## Contact

Made and maintained by Quinten. For questions, bugs or requests, [open an issue](../../issues).

## License

[MIT](LICENSE). Bundled libraries: [Zen Kaku Gothic New](src/renderer/fonts/OFL.txt) (SIL OFL 1.1), [skinview3d](src/renderer/vendor/skinview3d-LICENSE.txt) (MIT), [deepslate](src/renderer/vendor/deepslate-LICENSE.txt) (MIT). playit.gg's agent is downloaded from its official releases and is not part of this repository. Minecraft is a trademark of Mojang Synergies AB.
