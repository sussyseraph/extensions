export default new class Nyaa {
    base = 'https://nyaa.si'

    async single(query) {
        const {
            titles,
            episode,
            absoluteEpisodeNumber,
            exclusions = [],
            resolution,
            fetch
        } = query

        if (!titles?.length) return []

        return this.search({
            titles,
            episode,
            absoluteEpisode: absoluteEpisodeNumber,
            exclusions,
            resolution,
            mode: 'single',
            fetch
        })
    }

    async batch(query) {
        const {
            titles,
            exclusions = [],
            resolution,
            fetch
        } = query

        if (!titles?.length) return []

        return this.search({
            titles,
            exclusions,
            resolution,
            mode: 'batch',
            fetch
        })
    }

    async movie(query) {
        const {
            titles,
            resolution,
            exclusions = [],
            fetch
        } = query

        if (!titles?.length) return []

        return this.search({
            titles,
            exclusions,
            resolution,
            mode: 'movie',
            fetch
        })
    }

    async search({
                     titles,
                     episode,
                     absoluteEpisode,
                     exclusions,
                     resolution,
                     mode,
                     fetch
                 }) {
        if (typeof fetch !== 'function') {
            throw new Error('Hayase did not provide its CORS-enabled fetch function.')
        }

        const searchTitles = this.getSearchTitles(titles)
        if (!searchTitles.length) return []

        const searchQueries = this.buildSearchQueries({
            searchTitles,
            episode,
            absoluteEpisode,
            resolution,
            mode
        })

        const allResults = []

        for (const searchQuery of searchQueries) {
            const response = await fetch(this.buildFeedUrl(searchQuery))

            if (!response.ok) {
                throw new Error(`Nyaa.si returned HTTP ${response.status}.`)
            }

            const xml = await response.text()
            const items = this.parseFeed(xml)
            const results = items
                .map(item => this.mapResult(item, mode))
                .filter(Boolean)
                .filter(result => this.matchesExclusions(result, exclusions))

            console.debug(
                `[Nyaa] ${searchQuery}: ${items.length} RSS items, ` +
                `${results.length} usable results`
            )

            allResults.push(...results)
        }

        const results = this.deduplicateResults(allResults)

        return this.rankResults(results, {
            titles,
            episode,
            absoluteEpisode,
            resolution,
            mode
        })
    }

    buildFeedUrl(searchQuery) {
        const params = new URLSearchParams({
            page: 'rss',
            q: searchQuery,
            c: '1_0',
            f: '0',
            s: 'seeders',
            o: 'desc'
        })

        return this.base + '/?' + params.toString()
    }

    buildSearchQueries({
                           searchTitles,
                           episode,
                           absoluteEpisode,
                           resolution,
                           mode
                       }) {
        const resolutionTerm = this.normalizeResolution(resolution)
        const resolutionSearchTerm = resolutionTerm
            ? resolutionTerm + 'p'
            : ''
        const queries = []

        for (const title of searchTitles.slice(0, 2)) {
            if (mode === 'single') {
                if (episode != null) {
                    queries.push(this.joinSearchTerms(
                        title,
                        String(episode).padStart(2, '0'),
                        resolutionSearchTerm
                    ))
                }

                if (
                    absoluteEpisode != null &&
                    Number(absoluteEpisode) !== Number(episode)
                ) {
                    queries.push(this.joinSearchTerms(
                        title,
                        String(absoluteEpisode).padStart(2, '0'),
                        resolutionSearchTerm
                    ))
                }

                queries.push(this.joinSearchTerms(
                    title,
                    resolutionSearchTerm
                ))
            } else if (mode === 'batch') {
                queries.push(this.joinSearchTerms(
                    title,
                    'Batch',
                    resolutionSearchTerm
                ))

                queries.push(this.joinSearchTerms(
                    title,
                    'Complete',
                    resolutionSearchTerm
                ))

                queries.push(this.joinSearchTerms(
                    title,
                    resolutionSearchTerm
                ))
            } else {
                queries.push(this.joinSearchTerms(
                    title,
                    resolutionSearchTerm
                ))

                if (resolutionSearchTerm) {
                    queries.push(title)
                }
            }
        }

        return [...new Set(queries.filter(Boolean))].slice(0, 5)
    }

    joinSearchTerms(...terms) {
        return terms
            .filter(term => term != null && String(term).trim())
            .map(term => String(term).trim())
            .join(' ')
    }

    getSearchTitles(titles) {
        const usableTitles = [...new Set(
            titles
                .filter(title =>
                    typeof title === 'string' &&
                    title.trim()
                )
                .map(title => this.cleanSearchTitle(title))
                .filter(Boolean)
        )]

        const latinTitles = usableTitles.filter(title =>
            /[A-Za-z]/.test(title)
        )

        return latinTitles.length
            ? latinTitles
            : usableTitles
    }

    cleanSearchTitle(title) {
        return String(title ?? '')
            .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim()
    }

    parseFeed(xml) {
        if (
            typeof xml !== 'string' ||
            !/<rss\b/i.test(xml) ||
            !/<channel\b/i.test(xml)
        ) {
            throw new Error(
                'Nyaa.si did not return a valid RSS feed. ' +
                'The site may be unavailable or blocking the request.'
            )
        }

        return [...xml.matchAll(
            /<item\b[^>]*>([\s\S]*?)<\/item>/gi
        )]
            .map(match => match[1])
            .map(itemXml => ({
                title: this.getTagValue(itemXml, 'title'),
                link: this.getTagValue(itemXml, 'link'),
                guid: this.getTagValue(itemXml, 'guid'),
                pubDate: this.getTagValue(itemXml, 'pubDate'),
                hash: this.getTagValue(itemXml, 'nyaa:infoHash'),
                seeders: this.getTagValue(itemXml, 'nyaa:seeders'),
                leechers: this.getTagValue(itemXml, 'nyaa:leechers'),
                downloads: this.getTagValue(itemXml, 'nyaa:downloads'),
                size: this.getTagValue(itemXml, 'nyaa:size')
            }))
    }

    getTagValue(xml, tagName) {
        const escapedTagName = tagName.replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&'
        )
        const match = xml.match(new RegExp(
            `<${escapedTagName}(?:\\s[^>]*)?>` +
            `([\\s\\S]*?)` +
            `<\\/${escapedTagName}>`,
            'i'
        ))

        if (!match) return ''

        return this.decodeXml(
            match[1]
                .replace(/^\s*<!\[CDATA\[/, '')
                .replace(/\]\]>\s*$/, '')
                .trim()
        )
    }

    decodeXml(value) {
        const entities = {
            amp: '&',
            apos: "'",
            gt: '>',
            lt: '<',
            quot: '"'
        }

        return String(value ?? '')
            .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
                String.fromCodePoint(Number.parseInt(code, 16))
            )
            .replace(/&#(\d+);/g, (_, code) =>
                String.fromCodePoint(Number.parseInt(code, 10))
            )
            .replace(/&(amp|apos|gt|lt|quot);/gi, (_, entity) =>
                entities[entity.toLowerCase()]
            )
    }

    mapResult(item, mode) {
        const title = String(item.title ?? '').trim()
        const hash = String(item.hash ?? '')
            .trim()
            .toLowerCase()

        if (!title || !/^[a-f0-9]{40}$/i.test(hash)) {
            return null
        }

        const result = {
            title,
            link: hash,
            hash,
            seeders: this.toNumber(item.seeders),
            leechers: this.toNumber(item.leechers),
            downloads: this.toNumber(item.downloads),
            size: this.parseSize(item.size),
            date: this.parseDate(item.pubDate),
            accuracy: 'medium'
        }

        const id = this.extractId(item.guid || item.link)

        if (id != null) {
            result.id = id
        }

        if (mode === 'batch') {
            result.type = 'batch'
        }

        return result
    }

    extractId(value) {
        const match = String(value ?? '').match(
            /\/(?:view|download)\/(\d+)/i
        )

        if (!match) return null

        const id = Number(match[1])

        return Number.isSafeInteger(id)
            ? id
            : null
    }

    matchesExclusions(result, exclusions) {
        const normalizedTitle = result.title.toLowerCase()
        const normalizedExclusions = exclusions
            .filter(exclusion =>
                typeof exclusion === 'string' &&
                exclusion.trim()
            )
            .map(exclusion => exclusion.toLowerCase())

        return !normalizedExclusions.some(exclusion =>
            normalizedTitle.includes(exclusion)
        )
    }

    rankResults(results, {
        titles,
        episode,
        absoluteEpisode,
        resolution,
        mode
    }) {
        return results
            .map(result => {
                const titleScore = this.getTitleScore(
                    result.title,
                    titles
                )
                const episodeMatch = this.matchesEpisode(
                    result.title,
                    episode,
                    absoluteEpisode
                )
                const resolutionMatch = this.matchesResolution(
                    result.title,
                    resolution
                )
                const batchMatch = this.isBatchTitle(result.title)

                let score = titleScore * 20

                if (episodeMatch) {
                    score += 100
                }

                if (resolutionMatch) {
                    score += 30
                }

                if (mode === 'batch') {
                    score += batchMatch ? 100 : -25
                } else {
                    score += batchMatch ? -50 : 15
                }

                score += Math.min(result.seeders, 100)

                return {
                    result: {
                        ...result,
                        accuracy: this.getAccuracy({
                            titleScore,
                            episodeMatch,
                            resolutionMatch,
                            mode
                        })
                    },
                    score
                }
            })
            .sort((left, right) =>
                right.score - left.score ||
                right.result.seeders - left.result.seeders ||
                right.result.date.getTime() -
                left.result.date.getTime()
            )
            .map(entry => entry.result)
    }

    getTitleScore(resultTitle, titles) {
        const resultTokens = new Set(
            this.tokenizeTitle(resultTitle)
        )
        let bestScore = 0

        for (const title of titles) {
            const titleTokens = this.tokenizeTitle(title)
                .filter(token => ![
                    'a',
                    'an',
                    'the',
                    'season',
                    'part',
                    'cour',
                    'movie'
                ].includes(token))

            if (!titleTokens.length) continue

            const matches = titleTokens.filter(token =>
                resultTokens.has(token)
            ).length
            const score = matches / titleTokens.length

            bestScore = Math.max(bestScore, score)
        }

        return bestScore
    }

    tokenizeTitle(value) {
        return String(value ?? '')
            .normalize('NFKD')
            .replace(/\p{M}/gu, '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .trim()
            .split(/\s+/)
            .filter(Boolean)
    }

    matchesEpisode(title, episode, absoluteEpisode) {
        const episodeNumbers = [...new Set(
            [episode, absoluteEpisode]
                .filter(value =>
                    value != null &&
                    Number.isFinite(Number(value))
                )
                .map(value => Number(value))
        )]

        if (!episodeNumbers.length) {
            return true
        }

        return episodeNumbers.some(episodeNumber => {
            const escapedEpisode = String(
                episodeNumber
            ).replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&'
            )

            const patterns = [
                new RegExp(
                    `\\bS\\d{1,2}E0*${escapedEpisode}` +
                    `(?:v\\d+)?\\b`,
                    'i'
                ),
                new RegExp(
                    `\\b(?:E|EP|EPISODE)[ ._-]*` +
                    `0*${escapedEpisode}(?:v\\d+)?\\b`,
                    'i'
                ),
                new RegExp(
                    `(?:^|[^A-Za-z0-9])` +
                    `0*${escapedEpisode}(?:v\\d+)?` +
                    `(?=$|[^A-Za-z0-9])`,
                    'i'
                )
            ]

            return patterns.some(pattern =>
                pattern.test(title)
            )
        })
    }

    matchesResolution(title, resolution) {
        const normalizedResolution = this.normalizeResolution(
            resolution
        )

        if (!normalizedResolution) {
            return true
        }

        const dimensionMap = {
            '2160': [
                '3840x2160',
                '4096x2160'
            ],
            '1080': [
                '1920x1080'
            ],
            '720': [
                '1280x720'
            ],
            '540': [
                '960x540'
            ],
            '480': [
                '640x480',
                '720x480',
                '854x480'
            ]
        }
        const aliasMap = {
            '2160': [
                '4k',
                'uhd'
            ],
            '1080': [
                'fhd'
            ]
        }
        const patterns = [
            new RegExp(
                `(?:^|[^0-9])${normalizedResolution}p` +
                `(?:$|[^0-9])`,
                'i'
            ),
            ...(dimensionMap[normalizedResolution] ?? [])
                .map(dimension => new RegExp(
                    `(?:^|[^0-9])${dimension}` +
                    `(?:$|[^0-9])`,
                    'i'
                )),
            ...(aliasMap[normalizedResolution] ?? [])
                .map(alias => new RegExp(
                    `(?:^|[^A-Za-z0-9])${alias}` +
                    `(?:$|[^A-Za-z0-9])`,
                    'i'
                ))
        ]

        return patterns.some(pattern =>
            pattern.test(title)
        )
    }

    normalizeResolution(resolution) {
        return String(resolution ?? '')
            .trim()
            .replace(/p$/i, '')
    }

    isBatchTitle(title) {
        return /\b(?:batch|complete)\b|全集|(?:^|[^0-9])\d{1,3}\s*[-~–]\s*\d{1,3}(?:[^0-9]|$)|\bepisodes?\s*\d{1,3}\s*[-~–]\s*\d{1,3}\b/i
            .test(title)
    }

    getAccuracy({
                    titleScore,
                    episodeMatch,
                    resolutionMatch,
                    mode
                }) {
        if (
            titleScore >= 0.8 &&
            resolutionMatch &&
            (mode !== 'single' || episodeMatch)
        ) {
            return 'high'
        }

        if (
            titleScore >= 0.5 ||
            episodeMatch ||
            resolutionMatch
        ) {
            return 'medium'
        }

        return 'low'
    }

    deduplicateResults(results) {
        const seen = new Set()

        return results.filter(result => {
            const key = result.hash || result.link

            if (seen.has(key)) {
                return false
            }

            seen.add(key)

            return true
        })
    }

    toNumber(value) {
        const parsed = Number(
            String(value ?? '')
                .replace(/,/g, '')
                .trim()
        )

        return Number.isFinite(parsed)
            ? parsed
            : 0
    }

    parseSize(value) {
        const normalized = String(value ?? '')
            .replace(/,/g, '')
            .trim()
        const directNumber = Number(normalized)

        if (Number.isFinite(directNumber)) {
            return directNumber
        }

        const match = normalized.match(
            /^([\d.]+)\s*([KMGTPE]?i?B)$/i
        )

        if (!match) return 0

        const amount = Number(match[1])
        const unit = match[2].toUpperCase()
        const powers = {
            B: 0,
            KB: 1,
            KIB: 1,
            MB: 2,
            MIB: 2,
            GB: 3,
            GIB: 3,
            TB: 4,
            TIB: 4,
            PB: 5,
            PIB: 5,
            EB: 6,
            EIB: 6
        }
        const power = powers[unit]

        if (
            !Number.isFinite(amount) ||
            power == null
        ) {
            return 0
        }

        return Math.round(
            amount *
            Math.pow(
                unit.includes('I') ? 1024 : 1000,
                power
            )
        )
    }

    parseDate(value) {
        const date = new Date(value || 0)

        return Number.isNaN(date.getTime())
            ? new Date(0)
            : date
    }

    async test() {
        return true
    }
}()