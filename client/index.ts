import { Context } from '@cordisjs/client'
import YoutubeScheduleCard from './YoutubeScheduleCard.vue'

export default (ctx: Context) => {
  ctx.client.router.slot({
    type: 'home',
    component: YoutubeScheduleCard,
    order: 897
  })
}
