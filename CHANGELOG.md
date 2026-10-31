# Changelog

## [0.1.6](https://github.com/Dematom1/argocd-axi/compare/argocd-axi-v0.1.5...argocd-axi-v0.1.6) (2026-10-31)


### Features

* **apps:** add resource actions and automated sync writes ([#29](https://github.com/Dematom1/argocd-axi/issues/29)) ([3558dc5](https://github.com/Dematom1/argocd-axi/commit/3558dc5c738f12cc36a9f5b4788512a21189cfea))
* **ctx:** add interactive writable context selection ([#28](https://github.com/Dematom1/argocd-axi/issues/28)) ([f5ddbe4](https://github.com/Dematom1/argocd-axi/commit/f5ddbe448b7b688f92193f0ddaaf9c0cb5f46463))

## [0.1.5](https://github.com/Dematom1/argocd-axi/compare/argocd-axi-v0.1.4...argocd-axi-v0.1.5) (2026-10-31)


### Features

* **apps:** add confirmed rollback, refresh, and operation termination ([#24](https://github.com/Dematom1/argocd-axi/issues/24)) ([2a7da15](https://github.com/Dematom1/argocd-axi/commit/2a7da15c27082a8e7bb2dbb00d5da289879ed131))
* **ctx:** add interactive writable-context management ([#26](https://github.com/Dematom1/argocd-axi/issues/26)) ([2ca00b1](https://github.com/Dematom1/argocd-axi/commit/2ca00b118e095cd75df184ea5dbc3160a6ab03e1))


### Bug Fixes

* **cli:** encode all stdout as TOON ([#27](https://github.com/Dematom1/argocd-axi/issues/27)) ([0204c7a](https://github.com/Dematom1/argocd-axi/commit/0204c7afe89c41eb851a8df19ff7dcf351055ec5))

## [0.1.4](https://github.com/Dematom1/argocd-axi/compare/argocd-axi-v0.1.3...argocd-axi-v0.1.4) (2026-10-31)


### Features

* add bounded recovery previews to Argo CD app output ([#18](https://github.com/Dematom1/argocd-axi/issues/18)) ([0a903fb](https://github.com/Dematom1/argocd-axi/commit/0a903fbfcb89ffa6523ccc2bc59ab0b83fc731a1))
* **apps:** add confirmed single-application sync ([#20](https://github.com/Dematom1/argocd-axi/issues/20)) ([41aa887](https://github.com/Dematom1/argocd-axi/commit/41aa887b1b3c4ce9cb8b380353820dc6211ba974))
* **auth:** add Argo CD authentication setup guide ([#19](https://github.com/Dematom1/argocd-axi/issues/19)) ([5978b12](https://github.com/Dematom1/argocd-axi/commit/5978b12e6a9327b83054fd60693e9ad7a56ac23b))


### Bug Fixes

* emit decodable TOON help lists ([#21](https://github.com/Dematom1/argocd-axi/issues/21)) ([eb93495](https://github.com/Dematom1/argocd-axi/commit/eb934957ec71baaf7329242786a42bddb5d16bbf))
* restrict release bot exemptions to same-repository PRs ([#23](https://github.com/Dematom1/argocd-axi/issues/23)) ([5f837ce](https://github.com/Dematom1/argocd-axi/commit/5f837ce404cb71464c2fa9015212bfb63197a2d1))

## [0.1.3](https://github.com/Dematom1/argocd-axi/compare/argocd-axi-v0.1.2...argocd-axi-v0.1.3) (2026-10-30)


### Bug Fixes

* exempt release app pull requests from generated-file guard ([#17](https://github.com/Dematom1/argocd-axi/issues/17)) ([e0eaea2](https://github.com/Dematom1/argocd-axi/commit/e0eaea29f727d75edba36468cb71dce9ff151774))
* trigger CI on release PRs with a GitHub App token ([#14](https://github.com/Dematom1/argocd-axi/issues/14)) ([dda4017](https://github.com/Dematom1/argocd-axi/commit/dda4017bf7a951cd47e8f3b52dedb38c3e7f026e))

## [0.1.2](https://github.com/Dematom1/argocd-axi/compare/argocd-axi-v0.1.1...argocd-axi-v0.1.2) (2026-10-30)


### Bug Fixes

* validate scoped release tags ([#12](https://github.com/Dematom1/argocd-axi/issues/12)) ([7995245](https://github.com/Dematom1/argocd-axi/commit/7995245ba9421ae66f72d55152953d2f6e1de93a))

## [0.1.1](https://github.com/Dematom1/argocd-axi/compare/argocd-axi-v0.1.0...argocd-axi-v0.1.1) (2026-10-30)


### Features

* add read-only argocd-axi v1 CLI for agents ([#1](https://github.com/Dematom1/argocd-axi/issues/1)) ([d44b50d](https://github.com/Dematom1/argocd-axi/commit/d44b50dde34269d3836db143729b1d65885e359d))
* automate staged npm releases with release-please ([#8](https://github.com/Dematom1/argocd-axi/issues/8)) ([91a146b](https://github.com/Dematom1/argocd-axi/commit/91a146bce19e0b038471912ef8e8af0ee6facd07))


### Bug Fixes

* encode text output as valid TOON ([#9](https://github.com/Dematom1/argocd-axi/issues/9)) ([635e10f](https://github.com/Dematom1/argocd-axi/commit/635e10f096c493ee28d2bf17119178d93848fa08))
* resolve npm audit findings and require Node 22.12 ([#5](https://github.com/Dematom1/argocd-axi/issues/5)) ([9ee6e0f](https://github.com/Dematom1/argocd-axi/commit/9ee6e0f3665841c2f8c293f665de35d13e00ba66))
