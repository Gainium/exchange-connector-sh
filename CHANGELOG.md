# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.14] - 2025-11-10

### Added
- Hyperliquid sub-account support. 

## [1.1.13] – 2025-11-06

### Fixed
- Hyperliquid queue

## [1.1.12] – 2025-11-03

### Added
- Hyperliquid significant figures check

## [1.1.11] – 2025-10-29

### Changed
- Hyperliquid retry get order amount

## [1.1.10] – 2025-10-27

### Fixed
- Hyperliquid futures balance

## [1.1.9] – 2025-10-22

### Changed
- Bybit coinm quote workaround

## [1.1.8] – 2025-10-20

### Fixed
- Bitget USDC product type

## [1.1.7] – 2025-10-20

### Changed
- Coinbase retry count

## [1.1.6] – 2025-10-13

### Changed
- Bitget limiter logic

## [1.1.5] – 2025-10-07

### Changed
- Hyperliquid price precision logic

## [1.1.4] – 2025-10-01

### Fixed
- Hyperliquid get order retry

## [1.1.3] – 2025-09-29

### Changed
- Updated hyperliquid asset helper logic

### Fixed
- Spot order placement

## [1.1.2] – 2025-09-26

### Fixed
- Hyperliquid all open orders response

## [1.1.1] – 2025-09-26

### Changed
- Hyperliquid market order price deviation
- Hyperliquid spot reduce only flag
- Hyperliquid retry get order

## [1.1.0] – 2025-09-24

### Added
- Hyperliquid integration

## [1.0.13] - 2025-09-01

### Changed
- Bitget futures total balance calculation

## [1.0.12] - 2025-08-29

### Changed
- Bybit do not retry 403 error
  
## [1.0.11] - 2025-08-25

### Changed
- Bybit pre launch pairs

## [1.0.10] - 2025-08-19

### Fixed
- Coinbase limit_limit_gtc undefined

## [1.0.9] - 2025-08-18

### Fixed
- Kucoin handle error in change margin type method

## [1.0.8] - 2025-08-07

### Changed
- Binance logs reduced

## [Unreleased]

## [1.0.7] - 2025-07-24

### Changed
- Binance futures to drop long requests
- Bump dependencies

## [1.0.6] - 2025-07-16

### Added
- Added support for Bybit regional hosts (com, eu, nl, tr, kz, ge)
- New `BybitHost` enum with regional API endpoint mappings
- Enhanced Bybit exchange implementation to support host selection
- Added `bybitHost` parameter to exchange factory and verification helpers

### Changed
- Updated exchange service to accept `bybitHost` parameter
- Modified exchange controller to handle Bybit host configuration
- Enhanced verification helpers to support Bybit host validation
- Updated Bybit exchange constructor to accept optional host parameter

### Fixed
- Coinbase pagination

## [1.0.5] - 2025-07-10

### Added

- Added `futures_changeMarginType` method to KuCoin exchange implementation
- Support for switching between ISOLATED and CROSS margin modes in KuCoin futures
- Enhanced futures trading capabilities with margin mode management

## [1.0.4] - 2025-06-30

### Changed

- Switched to npm package manager
- Removed yarn.lock file (no longer needed with npm)

## [1.0.3] - 2025-06-27

### Security
- Bumped module versions to fix known vulnerability

### Changed
- Bumped binance-api-node from ^0.12.0 to ^0.12.9
- Bumped bitget-api from ^2.0.13 to ^2.3.5
- Bumped bybit-api from ^3.3.3 to ^4.1.13
- Bumped coinbase-advanced-node from ^3.0.1 to ^4.1.0
- Bumped okx-api from ^1.1.3 to ^2.0.5
- Updated exchange connector logic to accommodate new package versions
- Updated Bybit custom REST client implementation
- Updated exchange type definitions and implementations for Bitget, Bybit, and OKX
- Updated Binance exchange connector implementation

## [1.0.2] - 2025-06-26

### Added
- Introduction of custom REST clients for exchange implementations
- Enhanced exchange connector functionality across multiple exchanges

### Changed
- Updated Binance exchange implementation with custom REST client
- Updated Bybit exchange implementation with custom REST client
- Updated Bitget exchange implementation with custom REST client
- Updated Kucoin exchange implementation with custom REST client
- Updated OKX exchange implementation with custom REST client
- Updated Coinbase exchange implementation with custom REST client
- Adjustments made to corresponding test.ts files for all exchange implementations
- Enhanced rate limiting functionality for exchange implementations
- Refined verification helpers
- Updated environment sample configuration
- Updated project documentation (README.md)
- Updated dependency lockfile (yarn.lock)
- @gainium/kucoin-api updated from 1.0.3 to 1.0.4

### Fixed
- Various bug fixes and improvements across exchange implementations
- Enhanced error handling and reliability

### Removed
- Deleted src/utils/crypto.ts file

## [1.0.1] - Previous Release
- Initial stable release
