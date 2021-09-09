import { print } from 'graphql/language/printer'
import axios from 'axios'
import {
  fetchMemberSubscriptions,
  fetchMemberBasicInfo,
  setMemberTosToTrue,
  unsubscribe,
} from '~/apollo/queries/memberSubscription.gql'

import { API_PATH_FRONTEND } from '~/configs/config.js'
const baseUrl = process.browser
  ? `//${location.host}/`
  : 'http://localhost:3000/'
const apiUrl = `${baseUrl}${API_PATH_FRONTEND}/member-subscription/v0`

async function getMemberSubscriptionType(context) {
  // determine whether user is logged in or not
  const firebaseId = await getUserFirebaseId(context)
  if (!firebaseId) return 'not-member' // no user is logged in

  // get user's subscription state
  try {
    const subscriptions = await getMemberAllSubscriptions(firebaseId)

    if (!subscriptions.length) {
      return 'not-member'
    }

    // check member's latest subscription state
    const latestSubscription = subscriptions[0]
    const subscriptionFrequency = latestSubscription.frequency

    switch (subscriptionFrequency) {
      case 'one_time':
        return 'basic'

      case 'monthly':
        return 'month'

      case 'yearly':
        return 'year'

      default:
        return 'basic'
    }
  } catch (error) {
    console.error(error)
    return 'not-member'
  }
}

async function getMemberDetailData(context) {
  const firebaseId = await getUserFirebaseId(context)
  if (!firebaseId) return null

  try {
    const result = await fireGqlRequest(fetchMemberSubscriptions, {
      firebaseId,
    })

    const memberData = result?.data?.member
    return memberData
  } catch (error) {
    console.error(error)
    return {}
  }
}

async function cancelMemberSubscription(context, reason) {
  const firebaseId = await getUserFirebaseId(context)
  if (!firebaseId) return null

  try {
    // get user's newest subscription
    const subscriptions = await getMemberAllSubscriptions(firebaseId)
    const newestSubscription = subscriptions[0]

    if (newestSubscription.frequency === 'one_time') return

    const firebaseToken = getFirebaseToken(context)

    // change subscription.isCanceled to true (carry unsubscribe reason)
    await fireGqlRequest(
      unsubscribe,
      {
        id: newestSubscription.id,
        note: reason,
      },
      firebaseToken
    )

    return 'success'
  } catch (error) {
    console.error(error)
    return 'fail'
  }
}

async function getMemberAllSubscriptions(firebaseId) {
  try {
    // get user's subscription state
    const result = await fireGqlRequest(fetchMemberSubscriptions, {
      firebaseId,
    })

    // get member's all subscriptions
    const subscriptions = result?.data?.member?.subscription
    return subscriptions
  } catch (error) {
    // handle network error
    console.error(error)

    return []
  }
}

function getUserFirebaseId(context) {
  const currentUserUid = context.store?.state?.membership?.userUid

  return currentUserUid || null
}

async function fireGqlRequest(query, variables, firebaseToken) {
  const { data: result } = await axios({
    url: apiUrl,
    method: 'post',
    data: {
      query: print(query),
      variables,
    },
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${firebaseToken}`,
    },
  })

  if (result.errors) {
    throw new Error(result.errors[0].message)
  }

  return result
}

function getMemberPayRecords(memberData) {
  if (!memberData) return []

  const payRecords = []
  memberData.subscription.forEach((subscription) => {
    subscription.newebpayPayment?.forEach((newebpayPayment) => {
      const payRecord = {
        number: subscription.orderNumber,
        date: getFormatDate(newebpayPayment.paymentTime),
        type: getSubscriptionType(subscription.frequency),
        method: newebpayPayment.paymentMethod,
        methodNote: `(${newebpayPayment.cardInfoLastFour || ''})`,
        price: newebpayPayment.amount,
      }
      payRecords.push(payRecord)
    })
  })

  // sort all records by date_dsc
  payRecords.sort((recordA, recordB) => {
    return new Date(recordB.date) - new Date(recordA.date)
  })

  return payRecords
}

function getMemberSubscribePosts(memberData) {
  if (!memberData) return []

  const postList = []
  memberData.subscription.forEach((subscription) => {
    const post = {
      id: subscription.postId,
      title: subscription.postId,
      url: '/',
      deadline: getFormatDate(subscription.oneTimeEndDatetime),
    }
    postList.push(post)
  })
  return postList
}

function getSubscriptionType(type) {
  switch (type) {
    case 'yearly':
      return '年訂閱'
    case 'monthly':
      return '月訂閱'
    case 'one_time':
      return '單篇訂閱'
    default:
      break
  }
}

function getFormatDate(dateString) {
  const date = new Date(dateString)

  const year = date.getFullYear()
  const month = ('0' + (date.getMonth() + 1)).slice(-2)
  const day = ('0' + date.getDate()).slice(-2)

  return `${year}/${month}/${day}`
}

/*
 * Hint: How to verify member is premium or not?
 * https://mirrormedia.slack.com/archives/C028CE3BGA1/p1630551612076200
 */
function getMemberShipStatus(memberData) {
  if (!memberData) return []

  const latestSubscription = getLatestSubscription(memberData)
  const status = latestSubscription.frequency

  const memberShipStatus = {
    name: status,
    dueDate: getFormatDate(latestSubscription.periodEndDatetime),
    nextPayDate: getFormatDate(latestSubscription.periodNextPayDatetime),
    payMethod: latestSubscription.paymentMethod,
  }

  return memberShipStatus
}

function isMemberPremium(memberShipStatus) {
  const status = memberShipStatus?.name
  return status === 'yearly' || status === 'monthly' || status === 'disturb'
}

async function getMemberServiceRuleStatus(context) {
  // determine whether user is logged in or not
  const firebaseId = await getUserFirebaseId(context)
  if (!firebaseId) return null

  // get user's subscription state
  try {
    const result = await fireGqlRequest(fetchMemberBasicInfo, {
      firebaseId,
    })

    // check member's tos
    const member = result?.data?.member
    return !!member.tos
  } catch (error) {
    console.error(error)
    return false
  }
}

async function setMemberServiceRuleStatusToTrue(context) {
  // determine whether user is logged in or not
  const firebaseId = await getUserFirebaseId(context)
  if (!firebaseId) return null

  // get member's israfel ID
  const memberIsrafelId = await getMemberIsrafelId(firebaseId)
  // TODO： put member's israfelID to vuex

  const firebaseToken = getFirebaseToken(context)

  // fire mutation, set member's tos(service rule) to true
  try {
    const result = await fireGqlRequest(
      setMemberTosToTrue,
      {
        id: memberIsrafelId,
      },
      firebaseToken
    )

    // check member's tos
    const member = result?.data?.updatemember
    return !!member.tos
  } catch (error) {
    console.error(error)
  }
}

async function getMemberIsrafelId(firebaseId) {
  // TODO： put member's israfelID to vuex
  const result = await fireGqlRequest(fetchMemberBasicInfo, {
    firebaseId,
  })
  const memberIsrafelId = result?.data?.member?.id
  return memberIsrafelId
}

function getFirebaseToken(context) {
  return context.store?.state?.membership?.userToken
}

function getLatestSubscription(memberData) {
  return memberData?.subscription[0]
}

export {
  getMemberSubscriptionType,
  getMemberDetailData,
  getMemberPayRecords,
  getMemberSubscribePosts,
  getMemberShipStatus,
  isMemberPremium,
  getMemberServiceRuleStatus,
  setMemberServiceRuleStatusToTrue,
  cancelMemberSubscription,
}