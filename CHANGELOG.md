# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] - YYYY-MM-DD

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

### Fixed
- Various bug fixes and improvements across exchange implementations
- Enhanced error handling and reliability

### Removed
- Deleted src/utils/crypto.ts file

## [1.0.1] - Previous Release
- Initial stable release
