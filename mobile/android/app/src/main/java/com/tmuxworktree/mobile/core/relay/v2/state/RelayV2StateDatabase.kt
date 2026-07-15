package com.tmuxworktree.mobile.core.relay.v2.state

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [
        RelayV2AuthorityEntity::class,
        RelayV2ScopeEntity::class,
        RelayV2SessionEntity::class,
        RelayV2SnapshotStagingEntity::class,
        RelayV2SnapshotRecordEntity::class,
        RelayV2StateEventEntity::class,
    ],
    version = 1,
    exportSchema = true,
)
internal abstract class RelayV2StateDatabase : RoomDatabase() {
    abstract fun stateDao(): RelayV2StateDao

    companion object {
        const val DATABASE_NAME = "tw_mobile_relay_v2_state.db"

        /** Builds the independent v2 state database without wiring it into the app runtime. */
        fun build(context: Context): RelayV2StateDatabase = Room.databaseBuilder(
            context.applicationContext,
            RelayV2StateDatabase::class.java,
            DATABASE_NAME,
        ).build()
    }
}
