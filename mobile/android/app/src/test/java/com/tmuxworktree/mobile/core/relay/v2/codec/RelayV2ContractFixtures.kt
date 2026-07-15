package com.tmuxworktree.mobile.core.relay.v2.codec

import java.nio.charset.StandardCharsets
import java.util.Base64

internal data class RelayV2GoldenFixture(
    val name: String,
    val channel: String,
    val schema: String?,
    val frame: LinkedHashMap<String, Any?>,
    val normalized: Map<String, Any?>,
)

internal data class RelayV2InvalidCase(
    val name: String,
    val channel: String,
    val schema: String?,
    val bytes: ByteArray,
    val opcode: String?,
    val compressed: Boolean?,
    val contentEncoding: String?,
    val expectedCode: String,
    val expectedFailureClass: String,
)

internal data class RelayV2DialectFixture(
    val name: String,
    val input: Map<String, Any?>,
    val expected: Map<String, Any?>,
)

internal class RelayV2ContractFixtures {
    val manifest: Map<String, Any?> = readObject("v2/manifest.json")
    val golden: List<RelayV2GoldenFixture>
    val invalid: List<Map<String, Any?>> = readArray("v2/invalid-vectors.json")
    val dialect: List<RelayV2DialectFixture> = readArray("v2/dialect-outcomes.json").map {
        RelayV2DialectFixture(
            name = it.string("name"),
            input = it.map("input"),
            expected = it.map("expected"),
        )
    }

    private val goldenByName: Map<String, RelayV2GoldenFixture>

    init {
        val rawGolden = manifest.list("files")
            .map { it.asMap() }
            .filter { it.string("role") == "golden" }
            .flatMap { readArray("v2/" + it.string("path")) }
        val rawByName = rawGolden.associateBy { it.string("name") }
        val materialized = linkedMapOf<String, LinkedHashMap<String, Any?>>()

        fun materialize(name: String, stack: MutableSet<String>): LinkedHashMap<String, Any?> {
            materialized[name]?.let { return deepObjectClone(it) }
            val fixture = rawByName[name] ?: error("Unknown Relay v2 golden fixture " + name)
            check(stack.add(name)) { "Cyclic Relay v2 golden fixture " + name }
            val frame = if (fixture.containsKey("frame")) {
                deepObjectClone(fixture.map("frame"))
            } else {
                materialize(fixture.string("deriveFrom"), stack)
            }
            fixture.optionalMap("set")?.forEach { (pointer, value) ->
                setJsonPointer(frame, pointer, deepClone(value))
            }
            stack.remove(name)
            materialized[name] = frame
            return deepObjectClone(frame)
        }

        golden = rawGolden.map { fixture ->
            RelayV2GoldenFixture(
                name = fixture.string("name"),
                channel = fixture.string("channel"),
                schema = fixture.optionalString("schema"),
                frame = materialize(fixture.string("name"), linkedSetOf()),
                normalized = fixture.map("normalized"),
            )
        }
        goldenByName = golden.associateBy(RelayV2GoldenFixture::name)
    }

    fun invalidCases(): List<RelayV2InvalidCase> = buildList {
        invalid.forEach { vector ->
            val input = vector.map("input")
            when (input.string("kind")) {
                "all-golden-add-field" -> golden.forEach { fixture ->
                    val frame = deepObjectClone(fixture.frame)
                    setJsonPointer(frame, input.string("path"), deepClone(input["value"]))
                    add(invalidCase(vector, fixture, frame))
                }
                "all-golden-payload-add-field" -> golden
                    .filter { fixture ->
                        fixture.channel != "https" && fixture.frame["payload"] is Map<*, *>
                    }
                    .forEach { fixture ->
                        val frame = deepObjectClone(fixture.frame)
                        setJsonPointer(frame, input.string("path"), deepClone(input["value"]))
                        add(invalidCase(vector, fixture, frame))
                    }
                else -> add(materializeSingleInvalid(vector, input))
            }
        }
    }

    private fun materializeSingleInvalid(
        vector: Map<String, Any?>,
        input: Map<String, Any?>,
    ): RelayV2InvalidCase {
        val generated = generatedBytes(input)
        if (generated != null) {
            return invalidCase(
                vector = vector,
                channel = vector.string("channel"),
                schema = vector.optionalString("schema"),
                bytes = generated,
                opcode = null,
                compressed = null,
                contentEncoding = null,
            )
        }
        val fixture = goldenByName[input.string("fixture")]
            ?: error("Unknown Relay v2 golden fixture " + input.string("fixture"))
        val frame = deepObjectClone(fixture.frame)
        when (input.string("kind")) {
            "golden" -> Unit
            "golden-set" ->
                setJsonPointer(frame, input.string("path"), deepClone(input["value"]))
            "golden-repeat-array" -> {
                val target = jsonPointerParent(frame, input.string("path"))
                val key = jsonPointerSegments(input.string("path")).last()
                val source = target[key] as? List<*>
                    ?: error("Golden repeat target is not an array")
                require(source.isNotEmpty()) { "Golden repeat target is empty" }
                target[key] = List(input.int("count")) { deepClone(source.first()) }
            }
            "golden-base64-bytes" -> {
                val data = ByteArray(input.int("byteCount"))
                setJsonPointer(
                    frame,
                    input.string("path"),
                    Base64.getEncoder().encodeToString(data),
                )
            }
            else -> error("Unsupported invalid fixture kind " + input.string("kind"))
        }
        return invalidCase(
            vector = vector,
            channel = vector.string("channel").takeUnless { it == "all" } ?: fixture.channel,
            schema = vector.optionalString("schema") ?: fixture.schema,
            bytes = RelayV2StrictJson.stringify(frame).toByteArray(StandardCharsets.UTF_8),
            opcode = input.optionalString("opcode"),
            compressed = input.optionalBoolean("compressed"),
            contentEncoding = input.optionalString("contentEncoding"),
        )
    }

    private fun generatedBytes(input: Map<String, Any?>): ByteArray? {
        val text = when (input.string("kind")) {
            "utf8" -> input.string("wire")
            "repeat-ascii" -> input.string("ascii").repeat(input.int("count"))
            "nested-array" ->
                "[".repeat(input.int("depth")) + "0" + "]".repeat(input.int("depth"))
            "flat-object" -> RelayV2StrictJson.stringify(
                linkedMapOf<String, Any?>().apply {
                    repeat(input.int("keyCount")) { put("k" + it, it.toLong()) }
                },
            )
            "key-grid" -> RelayV2StrictJson.stringify(
                linkedMapOf<String, Any?>().apply {
                    repeat(input.int("objectCount")) { objectIndex ->
                        put(
                            "o" + objectIndex,
                            linkedMapOf<String, Any?>().apply {
                                repeat(input.int("keysPerObject")) {
                                    put("k" + it, it.toLong())
                                }
                            },
                        )
                    }
                },
            )
            "flat-array" -> RelayV2StrictJson.stringify(
                List(input.int("itemCount")) { it.toLong() },
            )
            "state-key-grid" -> RelayV2StrictJson.stringify(
                linkedMapOf(
                    "protocolVersion" to 2L,
                    "kind" to "response",
                    "type" to "state.snapshot.chunk",
                    "payload" to linkedMapOf(
                        "records" to List(input.int("objectCount")) { objectIndex ->
                            linkedMapOf<String, Any?>().apply {
                                repeat(input.int("keysPerObject")) {
                                    put("k" + objectIndex + "_" + it, it.toLong())
                                }
                            }
                        },
                    ),
                ),
            )
            "state-node-array" -> RelayV2StrictJson.stringify(
                linkedMapOf(
                    "protocolVersion" to 2L,
                    "kind" to "response",
                    "type" to "state.snapshot.chunk",
                    "payload" to linkedMapOf(
                        "records" to List(input.int("itemCount")) { 0L },
                    ),
                ),
            )
            "base64" -> return Base64.getDecoder().decode(input.string("data"))
            else -> return null
        }
        return text.toByteArray(StandardCharsets.UTF_8)
    }

    private fun invalidCase(
        vector: Map<String, Any?>,
        fixture: RelayV2GoldenFixture,
        frame: LinkedHashMap<String, Any?>,
    ): RelayV2InvalidCase = invalidCase(
        vector = vector,
        channel = fixture.channel,
        schema = fixture.schema,
        bytes = RelayV2StrictJson.stringify(frame).toByteArray(StandardCharsets.UTF_8),
        opcode = null,
        compressed = null,
        contentEncoding = null,
        nameSuffix = fixture.name,
    )

    private fun invalidCase(
        vector: Map<String, Any?>,
        channel: String,
        schema: String?,
        bytes: ByteArray,
        opcode: String?,
        compressed: Boolean?,
        contentEncoding: String?,
        nameSuffix: String? = null,
    ): RelayV2InvalidCase {
        val expected = vector.map("expected")
        return RelayV2InvalidCase(
            name = vector.string("name") + (nameSuffix?.let { ":" + it } ?: ""),
            channel = channel,
            schema = schema,
            bytes = bytes,
            opcode = opcode,
            compressed = compressed,
            contentEncoding = contentEncoding,
            expectedCode = expected.string("errorCode"),
            expectedFailureClass = expected.string("failureClass"),
        )
    }

    private fun readObject(path: String): Map<String, Any?> {
        val raw = readResource(path)
        return RelayV2StrictJson.parseObject(raw, FIXTURE_LIMITS)
    }

    private fun readArray(path: String): List<Map<String, Any?>> {
        val wrapper = RelayV2StrictJson.parseObject(
            "{\"fixtures\":" + readResource(path) + "}",
            FIXTURE_LIMITS,
        )
        return wrapper.list("fixtures").map { it.asMap() }
    }

    private fun readResource(path: String): String =
        requireNotNull(javaClass.classLoader?.getResourceAsStream(path)) {
            "Missing required repo Relay v2 fixture " + path
        }.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }

    companion object {
        private val FIXTURE_LIMITS = RelayV2JsonLimits(
            maxDepth = 64,
            maxDirectKeys = 1_024,
            maxTotalKeys = 100_000,
            maxNodes = 200_000,
        )
    }
}

private fun jsonPointerSegments(pointer: String): List<String> {
    require(pointer.startsWith("/")) { "Invalid JSON pointer" }
    return pointer.drop(1).split('/').map {
        it.replace("~1", "/").replace("~0", "~")
    }
}

private fun jsonPointerParent(
    root: LinkedHashMap<String, Any?>,
    pointer: String,
): MutableMap<String, Any?> {
    var target: MutableMap<String, Any?> = root
    jsonPointerSegments(pointer).dropLast(1).forEach { segment ->
        @Suppress("UNCHECKED_CAST")
        target = target[segment] as? MutableMap<String, Any?>
            ?: error("JSON pointer does not address an object")
    }
    return target
}

private fun setJsonPointer(root: LinkedHashMap<String, Any?>, pointer: String, value: Any?) {
    val target = jsonPointerParent(root, pointer)
    target[jsonPointerSegments(pointer).last()] = value
}

private fun deepObjectClone(value: Map<String, Any?>): LinkedHashMap<String, Any?> =
    linkedMapOf<String, Any?>().apply {
        value.forEach { (key, item) -> put(key, deepClone(item)) }
    }

private fun deepClone(value: Any?): Any? = when (value) {
    is Map<*, *> -> {
        @Suppress("UNCHECKED_CAST")
        deepObjectClone(value as Map<String, Any?>)
    }
    is List<*> -> value.map(::deepClone).toMutableList()
    else -> value
}

private fun Any?.asMap(): Map<String, Any?> {
    @Suppress("UNCHECKED_CAST")
    return this as? Map<String, Any?> ?: error("Fixture value must be an object")
}

private fun Map<String, Any?>.map(name: String): Map<String, Any?> =
    this[name].asMap()

private fun Map<String, Any?>.optionalMap(name: String): Map<String, Any?>? =
    this[name]?.asMap()

private fun Map<String, Any?>.list(name: String): List<Any?> =
    this[name] as? List<*> ?: error("Fixture field must be an array: " + name)

private fun Map<String, Any?>.string(name: String): String =
    this[name] as? String ?: error("Fixture field must be a string: " + name)

private fun Map<String, Any?>.optionalString(name: String): String? =
    this[name] as? String

private fun Map<String, Any?>.optionalBoolean(name: String): Boolean? =
    this[name] as? Boolean

private fun Map<String, Any?>.int(name: String): Int =
    (this[name] as? Number)?.toInt() ?: error("Fixture field must be an integer: " + name)
