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
                const targetEpisodes = this.getTargetEpisodes(
                    episode,
                    absoluteEpisode
                )

                if (targetEpisodes.length) {
                    for (const targetEpisode of targetEpisodes) {
                        const rawEpisode = String(targetEpisode)
                        const paddedEpisode = rawEpisode.padStart(2, '0')

                        queries.push(this.joinSearchTerms(
                            title,
                            paddedEpisode,
                            resolutionSearchTerm
                        ))

                        if (rawEpisode !== paddedEpisode) {
                            queries.push(this.joinSearchTerms(
                                title,
                                rawEpisode,
                                resolutionSearchTerm
                            ))
                        }
                    }
                } else {
                    queries.push(this.joinSearchTerms(
                        title,
                        resolutionSearchTerm
                    ))
                }
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

        return [...new Set(queries.filter(Boolean))].slice(0, 6)
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
        const targetEpisodes = this.getTargetEpisodes(
            episode,
            absoluteEpisode
        )
        const scoredResults = results.map(result => {
            const titleScore = this.getTitleScore(
                result.title,
                titles
            )
            const episodeMatchStrength = this.getEpisodeMatchStrength(
                result.title,
                episode,
                absoluteEpisode,
                titles
            )
            const resolutionMatch = this.matchesResolution(
                result.title,
                resolution
            )
            const batchMatch = this.isBatchTitle(result.title)

            return {
                result: {
                    ...result,
                    accuracy: this.getAccuracy({
                        titleScore,
                        episodeMatchStrength,
                        resolutionMatch,
                        mode
                    })
                },
                titleScore,
                episodeMatchStrength,
                resolutionMatch,
                batchMatch
            }
        })

        let candidates = scoredResults

        if (mode === 'single' && targetEpisodes.length) {
            candidates = scoredResults.filter(entry =>
                entry.episodeMatchStrength > 0 &&
                !entry.batchMatch
            )

            console.debug(
                `[Nyaa] Requested episode(s) ${targetEpisodes.join(', ')}: ` +
                `${candidates.length} exact episode candidates`
            )

            if (!candidates.length) {
                return []
            }
        }

        return candidates
            .sort((left, right) =>
                right.episodeMatchStrength - left.episodeMatchStrength ||
                right.titleScore - left.titleScore ||
                Number(right.resolutionMatch) - Number(left.resolutionMatch) ||
                Number(!right.batchMatch) - Number(!left.batchMatch) ||
                right.result.seeders - left.result.seeders ||
                right.result.downloads - left.result.downloads ||
                right.result.date.getTime() - left.result.date.getTime()
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

    getEpisodeMatchStrength(
        title,
        episode,
        absoluteEpisode,
        titles
    ) {
        const targetEpisodes = this.getTargetEpisodes(
            episode,
            absoluteEpisode
        )

        if (!targetEpisodes.length) {
            return 1
        }

        const explicitEpisodes = this.extractEpisodeNumbers(title, [
            /\bS\d{1,3}E0*(\d{1,4}(?:\.\d+)?)(?:v\d+)?\b/gi,
            /\b(?:EPISODE|EP|E)[ ._-]*0*(\d{1,4}(?:\.\d+)?)(?:v\d+)?\b/gi,
            /(?:^|[^A-Za-z0-9])#0*(\d{1,4}(?:\.\d+)?)(?:v\d+)?\b/gi
        ])

        if (this.hasTargetEpisode(explicitEpisodes, targetEpisodes)) {
            return 4
        }

        const delimiterEpisodes = this.extractEpisodeNumbers(title, [
            /(?:^|[\s._\[\](){}])[-–—][\s._-]*0*(\d{1,4}(?:\.\d+)?)(?:v\d+)?(?=$|[\s._\[\](){}])/gi,
            /(?:^|[\s._\[\](){}])0*(\d{1,4}(?:\.\d+)?)(?:v\d+)?[\s._-]*[-–—](?=$|[\s._\[\](){}])/gi
        ])

        if (this.hasTargetEpisode(delimiterEpisodes, targetEpisodes)) {
            return 3
        }

        const normalizedTitle = this.removeEpisodeNoise(
            title,
            titles
        )
        const standaloneEpisodes = this.extractEpisodeNumbers(
            normalizedTitle,
            [
                /(?:^|[^A-Za-z0-9])0*(\d{1,4}(?:\.\d+)?)(?:v\d+)?(?=$|[^A-Za-z0-9])/gi
            ]
        )

        if (this.hasTargetEpisode(standaloneEpisodes, targetEpisodes)) {
            return 2
        }

        return 0
    }

    getTargetEpisodes(episode, absoluteEpisode) {
        return [...new Set(
            [episode, absoluteEpisode]
                .filter(value =>
                    value != null &&
                    Number.isFinite(Number(value))
                )
                .map(value => Number(value))
        )]
    }

    extractEpisodeNumbers(title, patterns) {
        const episodeNumbers = []

        for (const pattern of patterns) {
            for (const match of String(title ?? '').matchAll(pattern)) {
                const episodeNumber = Number(match[1])

                if (Number.isFinite(episodeNumber)) {
                    episodeNumbers.push(episodeNumber)
                }
            }
        }

        return episodeNumbers
    }

    hasTargetEpisode(foundEpisodes, targetEpisodes) {
        return foundEpisodes.some(foundEpisode =>
            targetEpisodes.some(targetEpisode =>
                Math.abs(foundEpisode - targetEpisode) < 0.0001
            )
        )
    }

    removeEpisodeNoise(title, titles) {
        let normalizedTitle = String(title ?? '')

        for (const knownTitle of titles) {
            const titleTokens = this.cleanSearchTitle(knownTitle)
                .split(/\s+/)
                .filter(Boolean)

            if (!titleTokens.length) continue

            const pattern = titleTokens
                .map(token => token.replace(
                    /[.*+?^${}()|[\]\\]/g,
                    '\\$&'
                ))
                .join('[^\\p{L}\\p{N}]+')

            normalizedTitle = normalizedTitle.replace(
                new RegExp(pattern, 'giu'),
                ' '
            )
        }

        return normalizedTitle
            .replace(/\bS(?:EASON)?[ ._-]*\d{1,3}\b/gi, ' ')
            .replace(/\b(?:19|20)\d{2}\b/g, ' ')
            .replace(/\b(?:480|540|720|1080|1440|2160|4320)p\b/gi, ' ')
            .replace(/\b\d{3,4}x\d{3,4}\b/gi, ' ')
            .replace(/\b\d{1,2}[ ._-]*bit\b/gi, ' ')
            .replace(/\b\d(?:\.\d)?[ ._-]*(?:ch|channels?)\b/gi, ' ')
            .replace(/\b[257]\.1\b/g, ' ')
            .replace(/\[[A-Fa-f0-9]{8,40}\]/g, ' ')
            .replace(/(?:^|[^0-9])\d{1,4}\s*[-~–]\s*\d{1,4}(?=$|[^0-9])/g, ' ')
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
                    episodeMatchStrength,
                    resolutionMatch,
                    mode
                }) {
        if (
            titleScore >= 0.8 &&
            resolutionMatch &&
            (mode !== 'single' || episodeMatchStrength >= 2)
        ) {
            return 'high'
        }

        if (
            titleScore >= 0.5 ||
            episodeMatchStrength >= 1 ||
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