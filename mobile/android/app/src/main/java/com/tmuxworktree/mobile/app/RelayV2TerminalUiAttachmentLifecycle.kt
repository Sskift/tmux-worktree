package com.tmuxworktree.mobile.app

import kotlinx.coroutines.CompletableDeferred

internal sealed interface RelayV2TerminalAttachmentInstall<out AttachmentT> {
    data object Current : RelayV2TerminalAttachmentInstall<Nothing>
    data class Detach<AttachmentT>(
        val attachment: AttachmentT,
    ) : RelayV2TerminalAttachmentInstall<AttachmentT>
}

internal sealed interface RelayV2TerminalAttachmentDetach<out AttachmentT> {
    data class Detach<AttachmentT>(
        val attachment: AttachmentT,
    ) : RelayV2TerminalAttachmentDetach<AttachmentT>
    data object Await : RelayV2TerminalAttachmentDetach<Nothing>
    data object Detached : RelayV2TerminalAttachmentDetach<Nothing>
}

/**
 * Controller-free lifecycle cut for one ViewModel-owned terminal opening.
 *
 * A detach request wins synchronously even before the runtime attachment exists. The opener then
 * either proves that it abandoned before attach or owns the exact late attachment through detach.
 */
internal class RelayV2TerminalUiAttachmentLifecycle<AttachmentT : Any> {
    private sealed interface State<out AttachmentT> {
        data object Opening : State<Nothing>
        data object OpeningDetachRequested : State<Nothing>
        data class Attached<AttachmentT>(val attachment: AttachmentT) : State<AttachmentT>
        data class Detaching<AttachmentT>(val attachment: AttachmentT) : State<AttachmentT>
        data object DetachFailed : State<Nothing>
        data object Detached : State<Nothing>
    }

    private val lock = Any()
    private var state: State<AttachmentT> = State.Opening
    /** Exact attachment identity retained for close-after-detach coordination. */
    private var issuedAttachment: AttachmentT? = null
    private val detached = CompletableDeferred<Unit>()

    fun detachRequested(): Boolean = synchronized(lock) {
        state is State.OpeningDetachRequested ||
            state is State.Detaching ||
            state is State.DetachFailed ||
            state is State.Detached
    }

    fun attached(): AttachmentT? = synchronized(lock) {
        (state as? State.Attached)?.attachment
    }

    fun issuedAttachment(): AttachmentT? = synchronized(lock) { issuedAttachment }

    fun install(
        attachment: AttachmentT,
    ): RelayV2TerminalAttachmentInstall<AttachmentT> = synchronized(lock) {
        when (state) {
            State.Opening -> {
                issuedAttachment = attachment
                state = State.Attached(attachment)
                RelayV2TerminalAttachmentInstall.Current
            }
            State.OpeningDetachRequested -> {
                issuedAttachment = attachment
                state = State.Detaching(attachment)
                RelayV2TerminalAttachmentInstall.Detach(attachment)
            }
            else -> error("Terminal attachment was installed more than once")
        }
    }

    fun abandonOpening(): Boolean {
        val completed = synchronized(lock) {
            when (state) {
                State.Opening,
                State.OpeningDetachRequested,
                -> {
                    state = State.Detached
                    true
                }
                else -> false
            }
        }
        if (completed) detached.complete(Unit)
        return completed
    }

    fun requestDetach(): RelayV2TerminalAttachmentDetach<AttachmentT> = synchronized(lock) {
        when (val current = state) {
            State.Opening -> {
                state = State.OpeningDetachRequested
                RelayV2TerminalAttachmentDetach.Await
            }
            State.OpeningDetachRequested,
            is State.Detaching,
            State.DetachFailed,
            -> RelayV2TerminalAttachmentDetach.Await
            is State.Attached -> {
                state = State.Detaching(current.attachment)
                RelayV2TerminalAttachmentDetach.Detach(current.attachment)
            }
            State.Detached -> RelayV2TerminalAttachmentDetach.Detached
        }
    }

    fun completeDetach(attachment: AttachmentT) {
        synchronized(lock) {
            val current = state as? State.Detaching
                ?: error("Terminal detach completed without ownership")
            check(current.attachment === attachment) {
                "Terminal detach completed for a foreign attachment"
            }
            state = State.Detached
        }
        check(detached.complete(Unit))
    }

    fun failDetach(attachment: AttachmentT, failure: Throwable) {
        synchronized(lock) {
            val current = state as? State.Detaching
                ?: error("Terminal detach failed without ownership")
            check(current.attachment === attachment) {
                "Terminal detach failed for a foreign attachment"
            }
            state = State.DetachFailed
        }
        check(detached.completeExceptionally(failure))
    }

    suspend fun awaitDetached() {
        detached.await()
    }
}
