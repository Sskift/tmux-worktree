package com.tmuxworktree.mobile.core.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [
        HostEntity::class,
        ScopeEntity::class,
        SessionEntity::class,
        OutboxEntity::class,
        TimelineEntity::class,
        StreamCheckpointEntity::class,
    ],
    version = 1,
    exportSchema = true,
)
abstract class TwDatabase : RoomDatabase() {
    abstract fun twDao(): TwDao

    companion object {
        @Volatile
        private var instance: TwDatabase? = null

        fun get(context: Context): TwDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext,
                TwDatabase::class.java,
                "tw_mobile_v2.db",
            ).build().also { instance = it }
        }
    }
}
